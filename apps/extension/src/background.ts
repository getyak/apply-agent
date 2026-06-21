// Service worker — message broker between content.ts and popup.ts.
//
// Responsibilities (T5 scope):
//   - cache the most recent detection per-tab so the popup can render
//     even when reopened on the same page (content.ts won't re-fire on
//     popup open);
//   - probe the backend health endpoint when the popup asks, so the
//     popup can show a green/red dot for "Vantage is reachable".
//
// Out of scope here:
//   - JWT mint / refresh (Task T7 introduces /api/extension/handshake)
//   - actual form fill (Task T6 / T7)

import type { DetectionPayload, Message } from './messages.js';

// Default backend the popup probes. Overridable via chrome.storage.local
// when the dev wants to point at a local API. Production extension build
// will pin this to the prod URL.
const DEFAULT_BACKEND = 'http://localhost:8081';

interface CacheEntry {
  payload: DetectionPayload;
  tabId: number;
}

const CACHE_BY_TAB = new Map<number, CacheEntry>();

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.type === 'content/detection') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      CACHE_BY_TAB.set(tabId, { payload: msg.payload, tabId });
    }
    // Fire-and-forget; no response expected.
    return false;
  }

  if (msg.type === 'popup/request-snapshot') {
    void respondWithCurrentTab(sendResponse);
    return true; // keep the channel open for the async response
  }

  if (msg.type === 'popup/handshake-check') {
    void respondWithHandshake(sendResponse);
    return true;
  }

  return false;
});

async function respondWithCurrentTab(
  sendResponse: (msg: Message) => void,
): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    sendResponse({ type: 'background/snapshot', payload: null });
    return;
  }
  const cached = CACHE_BY_TAB.get(activeTab.id);
  sendResponse({ type: 'background/snapshot', payload: cached?.payload ?? null });
}

async function respondWithHandshake(
  sendResponse: (msg: Message) => void,
): Promise<void> {
  const backendUrl = await resolveBackendUrl();
  let ok = false;
  try {
    const resp = await fetch(`${backendUrl}/healthz`, { method: 'GET' });
    ok = resp.ok;
  } catch {
    ok = false;
  }
  sendResponse({ type: 'background/handshake-result', ok, backendUrl });
}

async function resolveBackendUrl(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['backendUrl'], (items) => {
      const stored = typeof items.backendUrl === 'string' ? items.backendUrl : null;
      resolve(stored || DEFAULT_BACKEND);
    });
  });
}

// Drop tab cache when the user navigates away or closes the tab — keeps
// CACHE_BY_TAB from leaking through service-worker restarts.
chrome.tabs.onRemoved.addListener((tabId) => {
  CACHE_BY_TAB.delete(tabId);
});
