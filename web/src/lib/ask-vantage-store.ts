// Ask Vantage dock state — kept in its own Zustand store so the giant
// VantageState in store.ts doesn't grow another 200 lines. The dock is
// the *persistent* surface that wraps every workspace screen: state
// here outlives route changes and Résumé / Mock surface mounts.
//
// thread_id model: one terminal thread per user (`ask_vantage:{user_id}`)
// — see docs/architecture/vantage-ui-mapping.md §1.2. The thread_id is
// derived from the auth store on first dock open and persisted to
// localStorage so dock refreshes keep continuity.

import { create } from "zustand";

export type DockState = "closed" | "docked" | "full";
export type DockMode = "greeting" | "chat" | "build";
export type AgentEventState = "running" | "done" | "failed";

// Composer attachments — file uploaded BEFORE the send fires, so the prompt
// can reference it by id. We carry name/size for the chip UI and the
// file_id so the future ask-stream contract can pass it server-side.
export interface DockAttachment {
  id: string;          // file id returned by POST /api/files
  name: string;        // original filename, for chip + accessibility label
  sizeBytes: number;
  kind: "pdf" | "docx" | "text";
}

// Each task card the dock shows during an agent run. The agent name
// matches LangGraph node names ("resume_agent", "jobmatch_agent", …)
// so we can map straight from astream_events into the card list.
export interface AgentEvent {
  id: string;
  agent: string;
  label: string;
  state: AgentEventState;
  statusText: string;
  ts: number;
}

export type DockMsgKind = "user" | "assistant" | "agents" | "result";

export interface DockMessage {
  id: string;
  kind: DockMsgKind;
  text?: string;
  agents?: string[];
  title?: string;
  sub?: string;
  action?: string;
  onAction?: () => void;
}

// One entry in the dock's RECENT rail. Each anchor is a past user prompt
// in the lifetime ask_vantage thread. Clicking an anchor doesn't switch
// threads — it scrolls the dock back to that turn (anchors-only model,
// vantage-ui-mapping §1.2). `id` is the conversation_messages.id from PG.
export interface RecentAnchor {
  id: string;
  preview: string;
  createdAt: string; // ISO from PG
}

interface DockStateShape {
  state: DockState;
  mode: DockMode;
  width: number;
  hintedCollapse: boolean;
  messages: DockMessage[];
  agentEvents: Record<string, AgentEvent>;
  input: string;
  attachments: DockAttachment[];
  threadId: string | null;
  streaming: boolean;
  abortController: AbortController | null;
  // Server-backed history rail. Loaded on mount via GET /api/ask/recent
  // and prepended to optimistically on each new user turn. We don't
  // dedupe by id on the client — server is the source of truth, the
  // next refresh from /recent will return the canonical row.
  recentAnchors: RecentAnchor[];

  open: () => void;
  close: () => void;
  toggleFull: () => void;
  toggleDock: () => void;
  setHintedCollapse: (v: boolean) => void;
  setWidth: (px: number) => void;
  setInput: (v: string) => void;
  setThreadId: (id: string) => void;
  setMode: (m: DockMode) => void;
  pushMessage: (m: Omit<DockMessage, "id"> & { id?: string }) => string;
  updateAgentEvent: (e: AgentEvent) => void;
  addAttachment: (a: DockAttachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  cancelStream: () => void;
  setStreaming: (v: boolean) => void;
  setRecentAnchors: (items: RecentAnchor[]) => void;
  // Optimistic append for a freshly-sent user prompt — we don't yet know
  // the persisted message id, so the caller passes a temp `id` (the
  // in-memory DockMessage id is fine). A later refresh from /recent will
  // overwrite the rail with canonical rows.
  prependRecentAnchor: (a: RecentAnchor) => void;
  reset: () => void;
}

const PERSISTED_WIDTH_KEY = "vantage.dock.width";
const PERSISTED_STATE_KEY = "vantage.dock.state";
const PERSISTED_THREAD_KEY = "vantage.dock.thread";

function readPersistedWidth(): number {
  if (typeof window === "undefined") return 372;
  const raw = window.localStorage.getItem(PERSISTED_WIDTH_KEY);
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 372;
  return Math.min(560, Math.max(280, n));
}

function readPersistedState(): DockState {
  if (typeof window === "undefined") return "docked";
  const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
  if (raw === "full" || raw === "closed" || raw === "docked") return raw;
  return "docked";
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export const useDock = create<DockStateShape>((set, get) => ({
  state: "docked",
  mode: "greeting",
  width: 372,
  hintedCollapse: false,
  messages: [],
  agentEvents: {},
  input: "",
  attachments: [],
  threadId: null,
  streaming: false,
  abortController: null,
  recentAnchors: [],

  open: () => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(PERSISTED_STATE_KEY, "docked");
    set({ state: "docked" });
  },
  close: () => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(PERSISTED_STATE_KEY, "closed");
    set({ state: "closed" });
    get().cancelStream();
  },
  toggleFull: () => {
    const next = get().state === "full" ? "docked" : "full";
    if (typeof window !== "undefined")
      window.localStorage.setItem(PERSISTED_STATE_KEY, next);
    set({ state: next });
  },
  toggleDock: () => {
    const cur = get().state;
    const next: DockState = cur === "closed" ? "docked" : "closed";
    if (typeof window !== "undefined")
      window.localStorage.setItem(PERSISTED_STATE_KEY, next);
    set({ state: next });
    if (next === "closed") get().cancelStream();
  },
  setHintedCollapse: (v) => set({ hintedCollapse: v }),
  setWidth: (px) => {
    const clamped = Math.min(560, Math.max(280, Math.round(px)));
    if (typeof window !== "undefined")
      window.localStorage.setItem(PERSISTED_WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },
  setInput: (v) => set({ input: v }),
  setThreadId: (id) => set({ threadId: id }),
  setMode: (m) => set({ mode: m }),
  pushMessage: (m) => {
    const id = m.id ?? nextId("dock");
    set((s) => ({ messages: [...s.messages, { ...m, id }] }));
    return id;
  },
  updateAgentEvent: (e) =>
    set((s) => ({ agentEvents: { ...s.agentEvents, [e.id]: e } })),
  addAttachment: (a) =>
    set((s) => ({ attachments: [...s.attachments.filter((x) => x.id !== a.id), a] })),
  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),
  cancelStream: () => {
    const c = get().abortController;
    if (c) c.abort();
    set({ abortController: null, streaming: false });
  },
  setStreaming: (v) => set({ streaming: v }),
  setRecentAnchors: (items) => set({ recentAnchors: items }),
  prependRecentAnchor: (a) =>
    set((s) => ({
      // Cap at 20 entries in memory so a long session doesn't grow the
      // rail unboundedly. The server query also caps; this is belt and
      // braces.
      recentAnchors: [a, ...s.recentAnchors].slice(0, 20),
    })),
  reset: () =>
    set({
      messages: [],
      agentEvents: {},
      input: "",
      attachments: [],
      mode: "greeting",
      streaming: false,
      abortController: null,
    }),
}));

// Bootstrapping: call once after `currentUser` resolves so the
// persistent thread_id matches the auth principal. If we don't
// have a user_id yet, fall back to a per-tab id stored in
// localStorage so the dock still works pre-login.
export function bootDockThread(userId: string | null) {
  const cur = useDock.getState();
  // A real user_id always wins. We may be called twice: first on first
  // paint before auth resolves (userId null → anon thread), then again
  // once currentUser lands. The second call must UPGRADE the anon thread
  // to the canonical ask_vantage:{userId} — so don't short-circuit on an
  // existing thread when it's still the anon one. (Guard against
  // clobbering an already-correct user thread, and never downgrade a
  // user thread back to anon when userId is null.)
  if (userId) {
    const id = `ask_vantage:${userId}`;
    if (cur.threadId === id) return; // already canonical
    if (typeof window !== "undefined")
      window.localStorage.setItem(PERSISTED_THREAD_KEY, id);
    useDock.getState().setThreadId(id);
    return;
  }
  if (cur.threadId) return;
  const persisted =
    typeof window !== "undefined"
      ? window.localStorage.getItem(PERSISTED_THREAD_KEY)
      : null;
  if (persisted) {
    useDock.getState().setThreadId(persisted);
    return;
  }
  const ephemeral = `ask_vantage:anon-${nextId("u")}`;
  if (typeof window !== "undefined")
    window.localStorage.setItem(PERSISTED_THREAD_KEY, ephemeral);
  useDock.getState().setThreadId(ephemeral);
}

// Hydrate width / state from localStorage after mount. Splitting this
// out of the create() defaults keeps SSR happy — defaults render the
// same on server and first client paint, then this catches up.
export function hydrateDockFromStorage() {
  // Narrow viewports can't host the 372px docked panel alongside the main
  // content (QA bug #8 — sidebar + main + dock fight for ~390px). Force the
  // launcher state below the lg breakpoint regardless of the stored value;
  // desktop users keep their preference.
  const narrow =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 1023px)").matches;
  useDock.setState({
    width: readPersistedWidth(),
    state: narrow ? "closed" : readPersistedState(),
  });
}
