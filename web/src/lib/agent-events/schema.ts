/**
 * Agent Event Stream — shared TypeScript schema for the AG-UI protocol as
 * extended by Relay. Mirrors agents/harness/events.py (Python emitter side).
 *
 * Why this file exists
 * --------------------
 * `@ag-ui/client` ships its own types but (a) Relay extends the envelope via
 * `event.rawEvent` (Python `raw_event` after camelCase serialization), and
 * (b) Relay defines a CUSTOM-event namespace (`relay.*`) carrying product
 * semantics (task_graph, artifact, browser_snapshot, file_edit, hitl_prep, …).
 * Both extensions need first-class TypeScript types so the reducer (PR3) can
 * pattern-match safely.
 *
 * Field naming
 * ------------
 * Top-level fields are camelCase because `ag-ui-protocol` Pydantic serializes
 * with `by_alias=True` (e.g. `raw_event` -> `rawEvent`, `thread_id` -> `threadId`).
 * Fields *inside* `rawEvent` keep snake_case because Relay injects the dict
 * directly without alias transformation — see RelayEmitter._meta in
 * agents/harness/events.py.
 *
 * See: docs/architecture/agent-event-stream.md §3
 */

// ---------------------------------------------------------------- EventType

export const EventType = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TEXT_MESSAGE_CHUNK: "TEXT_MESSAGE_CHUNK",
  REASONING_START: "REASONING_START",
  REASONING_END: "REASONING_END",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  REASONING_MESSAGE_CHUNK: "REASONING_MESSAGE_CHUNK",
  THINKING_START: "THINKING_START",
  THINKING_END: "THINKING_END",
  THINKING_TEXT_MESSAGE_START: "THINKING_TEXT_MESSAGE_START",
  THINKING_TEXT_MESSAGE_CONTENT: "THINKING_TEXT_MESSAGE_CONTENT",
  THINKING_TEXT_MESSAGE_END: "THINKING_TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_CHUNK: "TOOL_CALL_CHUNK",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
  ACTIVITY_SNAPSHOT: "ACTIVITY_SNAPSHOT",
  ACTIVITY_DELTA: "ACTIVITY_DELTA",
  RAW: "RAW",
  CUSTOM: "CUSTOM",
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

// ---------------------------------------------------------------- Relay envelope

/**
 * Lives inside `event.rawEvent`. Injected by agents/harness/events.py:RelayEmitter._meta.
 *
 * `seq` is monotonic within a single run; `id` is a ULID (lexicographically
 * sortable) — together they let the client de-duplicate and recover order if
 * SSE frames arrive out of order or are buffered/coalesced upstream.
 */
export interface RelayMeta {
  id: string; // ULID
  seq: number; // monotonic within run
  trace_id: string;
  run_id: string;
  thread_id: string;
  protocol_version: string;
  step_id?: string;
  parent_step_id?: string;
  // emitter `extra` overlay (plan_step ordinal, agent name, etc.)
  [k: string]: unknown;
}

// ---------------------------------------------------------------- CUSTOM names

/**
 * Closed set of Relay-defined CUSTOM event names. PR1 freezes this list;
 * adding a new one requires updating both this union AND the Python
 * registry in docs/architecture/agent-event-stream.md §3.3.
 *
 * Reducer in PR3 dispatches by these names. Any unknown `relay.*` name is
 * logged as `_unknown_custom` and stored in step.events but not rendered.
 */
export type RelayCustomName =
  | "relay.task_graph"
  | "relay.task_graph_step"
  | "relay.artifact"
  | "relay.partial_artifact"
  | "relay.narrator"
  | "relay.agents_group"
  | "relay.agent_start"
  | "relay.agent_done"
  | "relay.hitl_prep"
  | "relay.file_edit"
  | "relay.file_edit.preview"
  | "relay.browser_snapshot"
  | "relay.browser_action";

// ---------------------------------------------------------------- Event union

interface EventBase<T extends EventTypeName> {
  type: T;
  timestamp?: number;
  rawEvent?: RelayMeta;
}

export interface RunStartedEvent extends EventBase<"RUN_STARTED"> {
  threadId: string;
  runId: string;
  parentRunId?: string | null;
  input?: unknown;
}

export interface RunFinishedSuccessOutcome {
  type: "success";
}
export interface RunFinishedInterruptOutcome {
  type: "interrupt";
  interrupts: InterruptPayload[];
}
export type RunFinishedOutcome =
  | RunFinishedSuccessOutcome
  | RunFinishedInterruptOutcome;

export interface InterruptPayload {
  id: string;
  reason: string;
  message?: string | null;
  tool_call_id?: string | null;
  response_schema?: Record<string, unknown> | null;
  expires_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RunFinishedEvent extends EventBase<"RUN_FINISHED"> {
  threadId: string;
  runId: string;
  result?: unknown;
  outcome?: RunFinishedOutcome;
}

export interface RunErrorEvent extends EventBase<"RUN_ERROR"> {
  message: string;
  code?: string | null;
}

export interface TextMessageStartEvent extends EventBase<"TEXT_MESSAGE_START"> {
  messageId: string;
  role?: "assistant" | "user" | "developer" | "system";
  name?: string | null;
}
export interface TextMessageContentEvent
  extends EventBase<"TEXT_MESSAGE_CONTENT"> {
  messageId: string;
  delta: string;
}
export interface TextMessageEndEvent extends EventBase<"TEXT_MESSAGE_END"> {
  messageId: string;
}

export interface ReasoningMessageStartEvent
  extends EventBase<"REASONING_MESSAGE_START"> {
  messageId: string;
}
export interface ReasoningMessageContentEvent
  extends EventBase<"REASONING_MESSAGE_CONTENT"> {
  messageId: string;
  delta: string;
}
export interface ReasoningMessageEndEvent
  extends EventBase<"REASONING_MESSAGE_END"> {
  messageId: string;
}

export interface ToolCallStartEvent extends EventBase<"TOOL_CALL_START"> {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string | null;
}
export interface ToolCallArgsEvent extends EventBase<"TOOL_CALL_ARGS"> {
  toolCallId: string;
  delta: string;
}
export interface ToolCallEndEvent extends EventBase<"TOOL_CALL_END"> {
  toolCallId: string;
}
export interface ToolCallResultEvent extends EventBase<"TOOL_CALL_RESULT"> {
  toolCallId: string;
  messageId: string;
  content: string;
  role?: "tool" | null;
}

export interface StateSnapshotEvent extends EventBase<"STATE_SNAPSHOT"> {
  snapshot: unknown;
}
export interface StateDeltaEvent extends EventBase<"STATE_DELTA"> {
  delta: Array<{ op: string; path: string; value?: unknown; from?: string }>;
}

export interface CustomEvent<N extends RelayCustomName = RelayCustomName>
  extends EventBase<"CUSTOM"> {
  name: N;
  value: unknown;
}

export type AgentEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | CustomEvent;

// ---------------------------------------------------------------- Step model

/**
 * Aggregate entity rendered as a single card in the dock.
 * One step per logical activity (a thinking pass, a tool call, a file edit, …)
 * Built up incrementally by reducer.ts (PR3) by folding events into step state.
 */
export type StepKind =
  | "run" // root, the entire dock turn
  | "plan" // task graph from relay.task_graph
  | "thinking" // REASONING_MESSAGE_*
  | "assistant_text" // TEXT_MESSAGE_*
  | "tool" // TOOL_CALL_*
  | "file_edit" // relay.file_edit*
  | "browser" // relay.browser_*
  | "hitl" // RunFinished outcome=interrupt + relay.hitl_prep
  | "narrator" // relay.narrator (short ephemeral thought-aloud)
  | "artifact"; // relay.artifact / relay.partial_artifact

export type StepStatus =
  | "queued" // declared in plan, not started
  | "running" // in flight
  | "review" // awaiting user (HITL)
  | "done"
  | "failed"
  | "skipped";

export interface FileEditHunk {
  before: string;
  after: string;
}
export interface BrowserSnapshot {
  url: string;
  screenshotUrl: string;
  viewport: { w: number; h: number };
  accessibilityTree?: unknown;
  ts: number;
}
export interface BrowserAction {
  action: "click" | "fill" | "navigate";
  target: string;
  value?: string;
  ts: number;
}

export interface Step {
  id: string;
  run_id: string;
  parent_step_id?: string;
  kind: StepKind;
  status: StepStatus;
  title: string;
  started_at: number;
  finished_at?: number;
  duration_ms?: number;

  // kind-specific optional fields
  reasoning_text?: string;
  text?: string;
  tool?: {
    name: string;
    args?: unknown;
    result?: unknown;
    error?: { code: string; message: string };
  };
  file?: {
    path: string;
    language: string;
    hunks: FileEditHunk[];
    applied: boolean;
  };
  browser?: {
    snapshots: BrowserSnapshot[];
    actions: BrowserAction[];
  };
  hitl?: {
    interruptId: string;
    reason: string;
    message?: string;
    metadata?: Record<string, unknown>;
    decision?: unknown;
  };
  artifact?: { id: string; snapshot: unknown };
  narrator?: { text: string };

  // raw events feed (soft cap 200; reducer keeps first 50 + last 50 + sentinel)
  events: AgentEvent[];
}
