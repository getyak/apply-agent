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

interface DockStateShape {
  state: DockState;
  mode: DockMode;
  width: number;
  hintedCollapse: boolean;
  messages: DockMessage[];
  agentEvents: Record<string, AgentEvent>;
  input: string;
  threadId: string | null;
  streaming: boolean;
  abortController: AbortController | null;

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
  cancelStream: () => void;
  setStreaming: (v: boolean) => void;
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
  threadId: null,
  streaming: false,
  abortController: null,

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
  cancelStream: () => {
    const c = get().abortController;
    if (c) c.abort();
    set({ abortController: null, streaming: false });
  },
  setStreaming: (v) => set({ streaming: v }),
  reset: () =>
    set({
      messages: [],
      agentEvents: {},
      input: "",
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
  if (cur.threadId) return;
  const persisted =
    typeof window !== "undefined"
      ? window.localStorage.getItem(PERSISTED_THREAD_KEY)
      : null;
  if (userId) {
    const id = `ask_vantage:${userId}`;
    if (typeof window !== "undefined")
      window.localStorage.setItem(PERSISTED_THREAD_KEY, id);
    useDock.getState().setThreadId(id);
    return;
  }
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
  useDock.setState({
    width: readPersistedWidth(),
    state: readPersistedState(),
  });
}
