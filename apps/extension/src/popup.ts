// Popup script — render detection snapshot + drive fill + edit profile.
//
// Wires up:
//   - detection rendering (T5)
//   - profile inputs (chrome.storage.local) (T6)
//   - "Fill with profile" button + cloud LLM toggle (T6 + T7)
//   - fill summary card (counts what got filled, what's left)

import type { DetectionPayload, FillSummary, Message } from './messages.js';
import { EMPTY_PROFILE, type UserProfile, loadProfile, saveProfile } from './profile.js';

const RENDER_LIMIT = 12;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup: #${id} missing in popup.html`);
  return el as T;
}

async function sendMessage<T extends Message>(msg: Message): Promise<T | undefined> {
  return (await chrome.runtime.sendMessage(msg)) as T | undefined;
}

async function refresh(): Promise<void> {
  const snapshot = await sendMessage<Extract<Message, { type: 'background/snapshot' }>>({
    type: 'popup/request-snapshot',
  });
  renderSnapshot(snapshot?.payload ?? null);

  const handshake = await sendMessage<Extract<Message, { type: 'background/handshake-result' }>>({
    type: 'popup/handshake-check',
  });
  renderHandshake(handshake);
}

function renderSnapshot(payload: DetectionPayload | null): void {
  const atsEl = $<HTMLSpanElement>('ats');
  const countEl = $<HTMLElement>('field-count');
  const fieldsEl = $<HTMLDivElement>('fields');
  const emptyEl = $<HTMLDivElement>('empty');
  const fillBtn = $<HTMLButtonElement>('fill-btn');

  if (!payload) {
    atsEl.textContent = 'not an ATS page';
    countEl.textContent = '—';
    fieldsEl.replaceChildren();
    emptyEl.hidden = false;
    fillBtn.disabled = true;
    return;
  }

  const { context, fields } = payload;
  atsEl.textContent = describeContext(context);
  countEl.textContent = String(fields.length);
  emptyEl.hidden = fields.length > 0;
  fillBtn.disabled = fields.length === 0;

  fieldsEl.replaceChildren();
  for (const f of fields.slice(0, RENDER_LIMIT)) {
    const row = document.createElement('div');
    row.className = 'field';
    const label = document.createElement('strong');
    label.textContent = f.label;
    const meta = document.createElement('span');
    meta.className = 'type';
    meta.textContent = ` · ${f.type}${f.required ? ' · req' : ''}`;
    row.append(label, meta);
    fieldsEl.appendChild(row);
  }
  if (fields.length > RENDER_LIMIT) {
    const more = document.createElement('div');
    more.className = 'field dim';
    more.textContent = `+ ${fields.length - RENDER_LIMIT} more`;
    fieldsEl.appendChild(more);
  }
}

function renderHandshake(
  handshake: Extract<Message, { type: 'background/handshake-result' }> | undefined,
): void {
  const el = $<HTMLSpanElement>('handshake');
  if (!handshake) {
    el.textContent = 'unknown';
    el.className = 'dim';
    return;
  }
  if (handshake.ok) {
    el.textContent = `reachable · ${truncate(handshake.backendUrl, 24)}`;
    el.className = 'ok';
  } else {
    el.textContent = `unreachable · ${truncate(handshake.backendUrl, 24)}`;
    el.className = 'err';
  }
}

function describeContext(c: DetectionPayload['context']): string {
  if (c.source === 'other') return 'not an ATS page';
  const co = c.companySlug ?? '?';
  return `${c.source} · ${co}${c.externalId ? ` · ${c.externalId.slice(0, 10)}` : ''}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ─── profile editing ──────────────────────────────────────────────────

function profileInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[data-key]'));
}

async function hydrateProfile(): Promise<void> {
  const profile = await loadProfile();
  for (const input of profileInputs()) {
    const key = input.dataset.key as keyof UserProfile | undefined;
    if (!key) continue;
    input.value = profile[key] ?? '';
    input.addEventListener('change', () => void persistProfile());
  }
}

async function persistProfile(): Promise<void> {
  const partial: Partial<UserProfile> = {};
  for (const input of profileInputs()) {
    const key = input.dataset.key as keyof UserProfile | undefined;
    if (!key) continue;
    (partial as Record<string, string>)[key] = input.value.trim();
  }
  const merged: UserProfile = { ...EMPTY_PROFILE, ...partial };
  // Auto-derive fullName when empty but first+last are filled.
  if (!merged.fullName && (merged.firstName || merged.lastName)) {
    merged.fullName = `${merged.firstName} ${merged.lastName}`.trim();
  }
  await saveProfile(merged);
}

// ─── fill flow ────────────────────────────────────────────────────────

async function doFill(): Promise<void> {
  const useCloud = $<HTMLInputElement>('use-cloud').checked;
  const fillBtn = $<HTMLButtonElement>('fill-btn');
  fillBtn.disabled = true;
  fillBtn.textContent = useCloud ? 'Filling (local + cloud)…' : 'Filling…';

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      renderSummary(emptySummary(), 'No active tab.');
      return;
    }
    const reply = (await chrome.tabs.sendMessage(activeTab.id, {
      type: 'popup/fill-request',
      useCloud,
    } satisfies Message)) as Extract<Message, { type: 'content/fill-result' }> | undefined;

    if (reply?.type === 'content/fill-result') {
      renderSummary(reply.summary);
    } else {
      renderSummary(emptySummary(), 'No response from content script.');
    }
  } catch (err) {
    renderSummary(emptySummary(), `Error: ${(err as Error).message}`);
  } finally {
    fillBtn.disabled = false;
    fillBtn.textContent = 'Fill with profile';
  }
}

function emptySummary(): FillSummary {
  return {
    filledLocal: 0,
    filledCloud: 0,
    skippedSensitive: 0,
    unmatched: 0,
    errors: 0,
    remaining: [],
  };
}

function renderSummary(summary: FillSummary, footnote?: string): void {
  const el = $<HTMLDivElement>('summary');
  const cloud = summary.filledCloud > 0 ? ` + <strong>${summary.filledCloud}</strong> cloud` : '';
  const errors =
    summary.errors > 0
      ? ` · <span class="err">${summary.errors} error${summary.errors > 1 ? 's' : ''}</span>`
      : '';
  const remaining =
    summary.unmatched > 0
      ? ` · <span class="dim">${summary.unmatched} left for you</span>`
      : '';
  el.innerHTML = `Filled <strong>${summary.filledLocal}</strong> locally${cloud}${remaining}${errors}${footnote ? `<br><span class="dim">${footnote}</span>` : ''}`;
  el.hidden = false;
}

// ─── boot ─────────────────────────────────────────────────────────────

refresh().catch((err: unknown) => {
  console.error('vantage popup refresh failed', err);
});
hydrateProfile().catch((err: unknown) => {
  console.error('vantage popup profile hydrate failed', err);
});
$<HTMLButtonElement>('fill-btn').addEventListener('click', () => {
  void doFill();
});
