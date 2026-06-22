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
  // Inline-detail upgrade: accumulated provider chain-of-thought for this
  // agent's current run. Populated from the SSE `reasoning_delta` lane
  // (only present when the picked tier honors OpenRouter's reasoning
  // passthrough — DeepSeek V4 Pro / GLM-4.7). Empty / undefined means
  // "this tier doesn't reason out loud" and the dock's Thinking body
  // just shows the spinner header without a transcript.
  reasoningText?: string;
}

export type DockMsgKind =
  | "user"
  | "assistant"
  | "agents"
  | "result"
  | "task_graph"
  | "artifact"
  // Step 1 — italic "thought-aloud" chip fired before each execution tool.
  // Carries a single short sentence; rendered as a small italic line, no
  // avatar / bubble chrome. The model is required to emit this via the
  // narrate() tool so the dock surface always tracks what's about to
  // happen one beat ahead of the spinner.
  | "narrator"
  // Step 3 — collapsible tool console row. One per execution tool.
  // Default collapsed (1 line: name · summary · status). Expand to see
  // the rest. System tools (propose_plan / narrate / recall_*) are
  // filtered out upstream so the console stays signal-only.
  | "tool_trace"
  // Step 5 — in-progress artifact snapshot. The dock merges multiple
  // updates with the same artifactId into one card so users see the
  // bullets / cover letter / form answers appearing live instead of
  // waiting for the final tool_end. The eventual `artifact` frame
  // supersedes the partial.
  | "partial_artifact"
  // Inline HITL bubbles (P1-C) — rendered by the dock so the user never
  // has to leave the conversation to approve / pick / review. Each one
  // carries a resume_token that submitAskResume POSTs back to
  // /api/ask/resume; the LangGraph thread picks up where it paused.
  | "hitl_ask_user"
  | "hitl_diff"
  | "hitl_approval";

export type HitlStatus = "pending" | "submitting" | "answered" | "cancelled";

export interface HitlAskUserPayload {
  question: string;
  chips?: string[];
  freeForm: boolean;
}

export interface HitlDiffPayload {
  // Free-form on purpose — the agent decides the shape (résumé bullet
  // diff, JD-vs-profile, weak-points etc.). The render layer formats it.
  before: unknown;
  after: unknown;
  label?: string;
}

export interface HitlApprovalPayload {
  action: string;
  payload: unknown;
}

// Subset of ask-stream's Artifact that the dock needs to render. We
// deliberately don't pull the type from ask-stream.ts to keep the store
// independent of the streaming layer (the same store powers /recent
// rehydration which has no stream).
export type ArtifactType =
  | "resume_version"
  | "job_match_set"
  | "application_package"
  | "interview_session"
  | "cover_letter"
  | "market_snapshot";

export interface ArtifactSourceEvidence {
  label: string;
  route?: string;
}

export interface ArtifactAction {
  kind: "approve" | "tweak" | "discard" | "open";
  label: string;
  route?: string;
}

export interface ArtifactPayload {
  artifactType: ArtifactType;
  artifactId: string;
  artifactTitle: string;
  artifactSub: string;
  confidence?: number;
  needsUserReview?: boolean;
  sourceEvidence?: ArtifactSourceEvidence[];
  nextActions?: ArtifactAction[];
}

// Per-step run state inside a task_graph message. The dock animates rows
// as agent_start / agent_done frames arrive — the step is keyed on the
// `agent` string the planner emitted, so coordinator-side reordering
// doesn't break the UI.
export type TaskGraphStepStatus = "pending" | "running" | "done" | "review" | "failed";

export interface TaskGraphMsgStep {
  step: string;
  agent: string;
  label: string;
  requires_review?: boolean;
  status: TaskGraphStepStatus;
}

export interface DockMessage {
  id: string;
  kind: DockMsgKind;
  text?: string;
  agents?: string[];
  title?: string;
  sub?: string;
  action?: string;
  onAction?: () => void;
  // task_graph payload — present only when kind === "task_graph".
  taskId?: string;
  userGoal?: string;
  steps?: TaskGraphMsgStep[];
  // artifact payload — present only when kind === "artifact".
  artifact?: ArtifactPayload;
  // partial_artifact payload — present only when kind === "partial_artifact".
  // partialArtifactId is the merge key; we update an existing row instead
  // of pushing a new one when its id matches.
  partialArtifactId?: string;
  partialArtifactKind?: string;
  partialTitle?: string;
  partialSub?: string;
  partialProgress?: number;
  partialPayload?: unknown;
  // tool_trace payload — present only when kind === "tool_trace". Mirrors
  // the SSE payload + adds a client-only `startedAt` for the live-duration
  // chip; the row freezes when the next tool starts.
  toolName?: string;
  toolAgent?: string;
  toolAction?: string;
  toolStatus?: "ok" | "error";
  toolSummary?: string;
  toolStartedAt?: number;
  // Inline-detail upgrade: raw tool input + (capped) output for the
  // expandable Input / Output blocks. Both are optional — dock_agent caps
  // result to 8 KiB upstream; if either is undefined the ToolTraceRow
  // falls back to its prior metadata-only expand panel so old agents stay
  // legible.
  toolArgs?: unknown;
  toolResult?: unknown;
  // HITL payload — present only when kind starts with "hitl_". The token
  // is what /api/ask/resume needs to match the paused LangGraph thread.
  hitlStatus?: HitlStatus;
  resumeToken?: string;
  hitlAskUser?: HitlAskUserPayload;
  hitlDiff?: HitlDiffPayload;
  hitlApproval?: HitlApprovalPayload;
  // Free-form text the user typed into the HITL bubble's input (renders
  // back into the bubble after answer so the conversation reads cleanly).
  hitlAnswerSummary?: string;
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
  // Generic mutator for an existing message — used by task_graph rendering
  // and by future artifact / streaming partial updates. Quiet no-op if the
  // id has been evicted (e.g. reset() between turns).
  patchMessage: (id: string, patch: Partial<Omit<DockMessage, "id">>) => void;
  // Drive the step animation as agent_start / agent_done frames stream in.
  // `status` here is the post-event state (running on start, done on done,
  // failed on agent_failed). The mutator is a quiet no-op if the message
  // isn't a task_graph or the agent isn't listed in its plan.
  updateTaskGraphStep: (
    messageId: string,
    agent: string,
    status: TaskGraphStepStatus,
  ) => void;
  // Step 4: deterministic step-id-based update for the dock_agent path.
  // Uses the `step` id stamped by the Python translator instead of inferring
  // from agent name — covers plans where the same agent appears more than
  // once. Agent-based update stays for the legacy router-mode path.
  updateTaskGraphStepById: (
    messageId: string,
    stepId: string,
    status: TaskGraphStepStatus,
  ) => void;
  updateAgentEvent: (e: AgentEvent) => void;
  // Append a reasoning_delta chunk to the most recent *running* agent
  // event. The dock_agent SSE protocol guarantees these arrive between
  // an `agent_start` and the matching `agent_done`, so "most recent
  // running" is unambiguous. If no agent is currently running (the
  // model emitted reasoning before any tool/agent fired — rare on the
  // dock path), the delta is dropped on purpose: there's no spinner row
  // to attach it to yet, and we'd rather lose a few words than create
  // a phantom "coordinator" event the user has no way to interpret.
  appendReasoning: (text: string) => void;
  // Step 5: merge-or-push for a partial_artifact snapshot. Matches by
  // partialArtifactId; if a row with the same id exists in messages, we
  // patch it in place (so the user sees the live card update); otherwise
  // we push a new partial_artifact message. Returns the resulting id.
  upsertPartialArtifact: (snap: {
    artifactId: string;
    artifactKind: string;
    title?: string;
    sub?: string;
    progress?: number;
    payload?: unknown;
  }) => string;
  setHitlStatus: (id: string, status: HitlStatus, answerSummary?: string) => void;
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
  patchMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  updateTaskGraphStep: (messageId, agent, status) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId || m.kind !== "task_graph" || !m.steps) return m;
        // Only touch the first matching agent row whose state isn't terminal —
        // covers the (rare) case where the same agent appears twice in a plan
        // (e.g. customise → recustomise) without losing earlier "done" rows.
        let touched = false;
        const next = m.steps.map((st) => {
          if (touched) return st;
          if (st.agent !== agent) return st;
          if (st.status === "done" || st.status === "failed") return st;
          touched = true;
          return { ...st, status };
        });
        return touched ? { ...m, steps: next } : m;
      }),
    })),
  updateTaskGraphStepById: (messageId, stepId, status) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId || m.kind !== "task_graph" || !m.steps) return m;
        let touched = false;
        const next = m.steps.map((st) => {
          if (st.step !== stepId) return st;
          if (st.status === "done" || st.status === "failed") return st;
          touched = true;
          return { ...st, status };
        });
        return touched ? { ...m, steps: next } : m;
      }),
    })),
  updateAgentEvent: (e) =>
    set((s) => ({ agentEvents: { ...s.agentEvents, [e.id]: e } })),
  appendReasoning: (text) => {
    if (!text) return;
    set((s) => {
      // Pick the most recently created event that's still running. We
      // iterate values once and pick the largest ts to avoid relying on
      // insertion order, which Record<string,…> doesn't guarantee
      // post-React 18 strict-mode remounts.
      let target: AgentEvent | null = null;
      for (const ev of Object.values(s.agentEvents)) {
        if (ev.state !== "running") continue;
        if (!target || ev.ts > target.ts) target = ev;
      }
      if (!target) return s;
      const updated: AgentEvent = {
        ...target,
        reasoningText: (target.reasoningText ?? "") + text,
      };
      return { agentEvents: { ...s.agentEvents, [target.id]: updated } };
    });
  },
  upsertPartialArtifact: (snap) => {
    const state = get();
    const existing = state.messages.find(
      (m) => m.kind === "partial_artifact" && m.partialArtifactId === snap.artifactId,
    );
    const patch: Partial<DockMessage> = {
      partialArtifactId: snap.artifactId,
      partialArtifactKind: snap.artifactKind,
      partialTitle: snap.title,
      partialSub: snap.sub,
      partialProgress: snap.progress,
      partialPayload: snap.payload,
    };
    if (existing) {
      state.patchMessage(existing.id, patch);
      return existing.id;
    }
    return state.pushMessage({
      kind: "partial_artifact",
      ...patch,
    });
  },
  // HITL lifecycle helpers: keep the API narrow so dock.tsx + tests can
  // unit-test each transition without poking the message array directly.
  setHitlStatus: (id: string, status: HitlStatus, answerSummary?: string) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id
          ? {
              ...m,
              hitlStatus: status,
              ...(answerSummary !== undefined
                ? { hitlAnswerSummary: answerSummary }
                : {}),
            }
          : m,
      ),
    })),
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

// M2 (round-4): keep the dock honest under dynamic viewport changes
// (window resize on desktop, rotation on tablet, browser dev-tools open
// and squeeze the main pane). hydrateDockFromStorage runs once on mount
// and never re-evaluates, so a user who rotates a tablet from landscape
// (≥1024px → docked) to portrait (768px → still docked) would get the
// 372px panel chewing the main pane. This listener installs the same
// narrow-viewport guard as a MediaQueryList subscriber: every transition
// in/out of "narrow" re-applies the rule. We still defer to the
// localStorage preference on desktop, so the user's saved
// docked/full/closed choice survives a resize back to wide.
//
// Returns a teardown so the caller can detach on unmount.
export function installDockViewportWatcher(): () => void {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia("(max-width: 1023px)");
  const apply = (matches: boolean) => {
    if (matches) {
      // Narrow → force the launcher. Don't persist; the next wide
      // viewport restores the saved preference automatically.
      if (useDock.getState().state !== "closed") {
        useDock.setState({ state: "closed" });
      }
    } else {
      // Wide → re-honour the user's persisted preference. Only nudge if
      // we're currently in the auto-forced "closed" state; if the user
      // explicitly opened the dock at some point while narrow we'd see
      // "docked"/"full" and respect that.
      const persisted = readPersistedState();
      if (useDock.getState().state === "closed" && persisted !== "closed") {
        useDock.setState({ state: persisted });
      }
    }
  };
  // Initial sync — covers the case where this runs after a resize that
  // happened between mount and listener install.
  apply(mql.matches);
  const handler = (e: MediaQueryListEvent) => apply(e.matches);
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
