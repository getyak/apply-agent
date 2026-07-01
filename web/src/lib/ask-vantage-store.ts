// Ask Vantage dock *chrome* state — kept in its own Zustand store so the
// giant VantageState in store.ts doesn't grow another 200 lines. The dock is
// the *persistent* surface that wraps every workspace screen: state here
// outlives route changes and Résumé / Mock surface mounts.
//
// Scope after the AG-UI rebuild (PR3): this store owns only dock *chrome* —
// open/dock/full state, width, composer input, staged attachments, the
// lifetime thread_id, the streaming flag, and the recent-anchors rail. The
// live conversation (steps) now lives in lib/agent-events/store.ts and is
// rendered by <StepTimeline />. The old DockMessage / AgentEvent model and
// its task-graph / partial-artifact / HITL mutators are gone.
//
// thread_id model: one terminal thread per user (`ask_vantage:{user_id}`)
// — see docs/architecture/vantage-ui-mapping.md §1.2. The thread_id is
// derived from the auth store on first dock open and persisted to
// localStorage so dock refreshes keep continuity.

import { create } from "zustand";

export type DockState = "closed" | "docked" | "full";
export type DockMode = "greeting" | "chat" | "build";

// Composer attachments — file uploaded BEFORE the send fires, so the prompt
// can reference it by id. We carry name/size for the chip UI and the file_id
// so sendAsk can pass it server-side.
export interface DockAttachment {
  id: string; // file id returned by POST /api/files
  name: string; // original filename, for chip + accessibility label
  sizeBytes: number;
  kind: "pdf" | "docx" | "text";
}

// One entry in the dock's RECENT rail. Each anchor is a past user prompt in
// the lifetime ask_vantage thread. Clicking an anchor doesn't switch threads
// — it scrolls the dock back to that turn (anchors-only model,
// vantage-ui-mapping §1.2). `id` is the conversation_messages.id from PG (or
// an in-memory id for an optimistic just-sent prompt).
export interface RecentAnchor {
  id: string;
  preview: string;
  createdAt: string; // ISO from PG
}

// Multi-session entry — surfaced in the dock header's SessionSwitcher.
// Mirrors api.ts AskSession (see web/src/lib/api.ts) so consumers can pass
// fetched rows straight into setSessions without an adapter step.
export interface DockSession {
  id: string;
  threadId: string;
  label: string;
  preview: string | null;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

interface DockStateShape {
  state: DockState;
  mode: DockMode;
  width: number;
  hintedCollapse: boolean;
  input: string;
  attachments: DockAttachment[];
  threadId: string | null;
  streaming: boolean;
  abortController: AbortController | null;
  recentAnchors: RecentAnchor[];
  // Multi-session (PR2). `sessions` is the dock's local mirror of
  // /api/ask/sessions; `activeSessionId` indexes into it. Empty array means
  // we haven't fetched yet (or the user has no rows yet — first send
  // creates one server-side via persist_turn).
  sessions: DockSession[];
  activeSessionId: string | null;

  open: () => void;
  close: () => void;
  toggleFull: () => void;
  toggleDock: () => void;
  setHintedCollapse: (v: boolean) => void;
  setWidth: (px: number) => void;
  setInput: (v: string) => void;
  setThreadId: (id: string) => void;
  setMode: (m: DockMode) => void;
  addAttachment: (a: DockAttachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  cancelStream: () => void;
  setStreaming: (v: boolean) => void;
  setRecentAnchors: (items: RecentAnchor[]) => void;
  prependRecentAnchor: (a: RecentAnchor) => void;
  setSessions: (rows: DockSession[]) => void;
  upsertSession: (row: DockSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
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
  input: "",
  attachments: [],
  threadId: null,
  streaming: false,
  abortController: null,
  recentAnchors: [],
  sessions: [],
  activeSessionId: null,

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
      // Cap at 20 entries in memory so a long session doesn't grow the rail
      // unboundedly. The server query also caps; this is belt and braces.
      recentAnchors: [a, ...s.recentAnchors].slice(0, 20),
    })),
  setSessions: (rows) => set({ sessions: rows }),
  upsertSession: (row) =>
    set((s) => {
      const filtered = s.sessions.filter((x) => x.id !== row.id);
      // Newest activity first (the gateway's list is already sorted but
      // local mutations need to keep that invariant).
      return { sessions: [row, ...filtered] };
    }),
  removeSession: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
    })),
  setActiveSession: (id) => set({ activeSessionId: id }),
  reset: () =>
    set({
      input: "",
      attachments: [],
      mode: "greeting",
      streaming: false,
      abortController: null,
    }),
}));

// Bootstrapping: call once after `currentUser` resolves so the persistent
// thread_id matches the auth principal. If we don't have a user_id yet, fall
// back to a per-tab id stored in localStorage so the dock still works
// pre-login.
export function bootDockThread(userId: string | null) {
  const cur = useDock.getState();
  // A real user_id always wins. We may be called twice: first on first paint
  // before auth resolves (userId null → anon thread), then again once
  // currentUser lands. The second call must UPGRADE the anon thread to the
  // canonical ask_vantage:{userId} — so don't short-circuit on an existing
  // thread when it's still the anon one.
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

// Hydrate width / state from localStorage after mount. Splitting this out of
// the create() defaults keeps SSR happy — defaults render the same on server
// and first client paint, then this catches up.
export function hydrateDockFromStorage() {
  // Narrow viewports can't host the 372px docked panel alongside the main
  // content. Force the launcher state below the lg breakpoint regardless of
  // the stored value; desktop users keep their preference.
  const narrow =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 1023px)").matches;
  useDock.setState({
    width: readPersistedWidth(),
    state: narrow ? "closed" : readPersistedState(),
  });
}

// Keep the dock honest under dynamic viewport changes (window resize on
// desktop, rotation on tablet). hydrateDockFromStorage runs once on mount and
// never re-evaluates, so this MediaQueryList subscriber re-applies the
// narrow-viewport guard on every transition in/out of "narrow". Returns a
// teardown so the caller can detach on unmount.
export function installDockViewportWatcher(): () => void {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia("(max-width: 1023px)");
  const apply = (matches: boolean) => {
    if (matches) {
      if (useDock.getState().state !== "closed") {
        useDock.setState({ state: "closed" });
      }
    } else {
      const persisted = readPersistedState();
      if (useDock.getState().state === "closed" && persisted !== "closed") {
        useDock.setState({ state: persisted });
      }
    }
  };
  apply(mql.matches);
  const handler = (e: MediaQueryListEvent) => apply(e.matches);
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
