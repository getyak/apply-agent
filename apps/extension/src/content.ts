// Content script — runs on Greenhouse / Lever / Ashby pages.
//
// Lifecycle:
//   1. document_idle fires (the page's initial JS has run).
//   2. detectATS + detectFields, push payload to background.
//   3. Re-scan whenever the SPA mutates the form so the popup never stalls
//      on a stale count.
//   4. On a fill-request from the popup: plan local fills, optionally call
//      the cloud filler for the leftovers (T7), apply DOM changes, and
//      report a FillSummary back so the popup can show counts.

import { type DetectedField, detectATS, detectFields } from './ats-detect.js';
import { fetchCloudFills } from './cloud-fill.js';
import { applyFills } from './dom-fill.js';
import { planLocalFill } from './local-fill.js';
import type { DetectionPayload, FillSummary, Message } from './messages.js';
import { loadProfile } from './profile.js';

const RESCAN_DEBOUNCE_MS = 300;

function buildPayload(): DetectionPayload {
  const context = detectATS();
  const fields = detectFields();
  const url = new URL(window.location.href);
  return {
    context,
    fields,
    detectedAt: Date.now(),
    pageUrl: `${url.origin}${url.pathname}`,
  };
}

function reportToBackground(payload: DetectionPayload): void {
  const message: Message = { type: 'content/detection', payload };
  chrome.runtime.sendMessage(message).catch(() => {
    // Background may not be alive yet (cold start) — popup will pull via
    // background/snapshot lazily, so we don't retry here.
  });
}

let rescanTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRescan(): void {
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    reportToBackground(buildPayload());
  }, RESCAN_DEBOUNCE_MS);
}

// Listen for fill requests from the popup.
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === 'popup/fill-request') {
    void doFill(msg.useCloud).then((summary) => {
      sendResponse({ type: 'content/fill-result', summary } satisfies Message);
    });
    return true; // async response
  }
  return false;
});

async function doFill(useCloud: boolean): Promise<FillSummary> {
  const payload = buildPayload();
  const profile = await loadProfile();
  const plan = planLocalFill(payload.fields, profile);

  const local = await applyFills(plan.fills);

  let filledCloud = 0;
  let cloudUnmatched: DetectedField[] = plan.unmatched;
  if (useCloud && plan.unmatched.length > 0) {
    const cloud = await fetchCloudFills({
      context: payload.context,
      jdUrl: payload.context.jdUrl,
      fields: plan.unmatched,
    });
    if (cloud) {
      const cloudResult = await applyFills(cloud.fills);
      filledCloud = cloudResult.filled;
      cloudUnmatched = cloud.unmatched;
    }
  }

  return {
    filledLocal: local.filled,
    filledCloud,
    skippedSensitive: 0, // server-side counts the sensitive skips; the local
    //                      mapper never had a chance to fill them
    unmatched: cloudUnmatched.length,
    errors: local.errors.length,
    remaining: cloudUnmatched,
  };
}

// Initial detection.
reportToBackground(buildPayload());

// Re-scan when the SPA reshapes the form (common on Workday-style multi-step
// flows; Greenhouse and Lever tend to render once but be defensive).
const observer = new MutationObserver(scheduleRescan);
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: false,
});
