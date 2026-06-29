/**
 * reducer.ts — folds a stream of AG-UI {@link AgentEvent}s into the
 * dock's `Map<stepId, Step>` aggregate. Pure: no React, no Zustand, no IO.
 *
 * Why a reducer (not a switch inside the store)
 * ---------------------------------------------
 * Keeping the fold pure means it is unit-testable in `bun:test` without a
 * DOM, and the store layer (store.ts) becomes a thin wrapper that owns
 * subscriptions + ordering. It also lets the contract test feed the same
 * Python-emitted fixtures (agents/tests/fixtures/agui_events.jsonl)
 * through the exact code path the live dock uses.
 *
 * Mapping (docs/architecture/agent-event-stream.md §3.2 / §7.3)
 * ------------------------------------------------------------
 *   RUN_STARTED                 → create root "run" step
 *   RUN_FINISHED (success)      → root → done
 *   RUN_FINISHED (interrupt)    → spawn one "hitl" step per interrupt
 *   RUN_ERROR                   → root → failed
 *   REASONING_MESSAGE_*         → "thinking" step, append reasoning_text
 *   TEXT_MESSAGE_*              → "assistant_text" step, append text
 *   TOOL_CALL_START/ARGS/END    → "tool" step (args streamed as JSON delta)
 *   TOOL_CALL_RESULT            → tool step → done/failed, set result
 *   STATE_SNAPSHOT/STATE_DELTA  → applied to the run step's events feed only
 *   CUSTOM                      → delegated to custom.ts (relay.* dispatch)
 *
 * Step identity: AG-UI keys streaming events by `messageId` / `toolCallId`,
 * not the Relay `step_id`. We therefore derive a stable step id from those
 * AG-UI identifiers (prefixed so a message id and a tool id can never
 * collide) and fall back to the Relay meta `step_id` for CUSTOM events.
 */

import type {
  AgentEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  Step,
  StepKind,
  TextMessageContentEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "./schema";
import { extractRelayMeta } from "./relay-meta";
import { applyCustom } from "./custom";

// The store keeps insertion order separately from the Map (Map preserves
// insertion order, but we want a stable explicit array; the reducer returns
// a fresh object each call so React can diff cheaply).
export interface ReducerState {
  steps: Map<string, Step>;
  /** Insertion order of step ids — the timeline renders in this order. */
  order: string[];
  /** Root run step id for the current turn (null before RUN_STARTED). */
  rootStepId: string | null;
}

export function emptyState(): ReducerState {
  return { steps: new Map(), order: [], rootStepId: null };
}

// Soft cap per step.events — keep first 50 + last 50 + a sentinel so a
// runaway stream (100 tok/s reasoning) can't grow one step's debug feed
// without bound. See plan PR3 constraint #7.
const EVENTS_SOFT_CAP = 200;
const EVENTS_HEAD = 50;
const EVENTS_TAIL = 50;

/**
 * Sentinel pushed into step.events when the feed is truncated. Typed as a
 * CUSTOM event so it satisfies AgentEvent without widening the union; the
 * UI never renders step.events directly, this is purely a debug marker.
 */
function truncationSentinel(dropped: number): AgentEvent {
  return {
    type: "CUSTOM",
    name: "relay.narrator",
    value: { _truncated: dropped },
  } as AgentEvent;
}

function appendEvent(step: Step, evt: AgentEvent): AgentEvent[] {
  const feed = step.events;
  if (feed.length < EVENTS_SOFT_CAP) return [...feed, evt];
  // Already at/over cap — collapse to head + sentinel + tail + new event.
  const head = feed.slice(0, EVENTS_HEAD);
  const tail = feed.slice(feed.length - EVENTS_TAIL + 1);
  const dropped = feed.length - EVENTS_HEAD - (EVENTS_TAIL - 1);
  return [...head, truncationSentinel(dropped), ...tail, evt];
}

// ---------------------------------------------------------------- ids

const MSG_PREFIX = "msg:";
const TOOL_PREFIX = "tool:";

function messageStepId(messageId: string): string {
  return `${MSG_PREFIX}${messageId}`;
}
function toolStepId(toolCallId: string): string {
  return `${TOOL_PREFIX}${toolCallId}`;
}

// ---------------------------------------------------------------- helpers

function nowTs(evt: AgentEvent): number {
  return typeof evt.timestamp === "number" ? evt.timestamp : Date.now();
}

export function makeStep(partial: {
  id: string;
  kind: StepKind;
  status: Step["status"];
  title: string;
  started_at: number;
  parent_step_id?: string;
  run_id?: string;
}): Step {
  return {
    id: partial.id,
    run_id: partial.run_id ?? "",
    parent_step_id: partial.parent_step_id,
    kind: partial.kind,
    status: partial.status,
    title: partial.title,
    started_at: partial.started_at,
    events: [],
  };
}

/**
 * Immutably set a step, registering its id in `order` if new. Returns a
 * fresh ReducerState. Shared with custom.ts via the helper bag.
 */
export function upsertStep(state: ReducerState, step: Step): ReducerState {
  const steps = new Map(state.steps);
  const exists = steps.has(step.id);
  steps.set(step.id, step);
  return {
    steps,
    order: exists ? state.order : [...state.order, step.id],
    rootStepId: state.rootStepId,
  };
}

// ---------------------------------------------------------------- reducer

export function applyEvent(state: ReducerState, evt: AgentEvent): ReducerState {
  const meta = extractRelayMeta(evt);
  const runId = meta.run_id;

  switch (evt.type) {
    case "RUN_STARTED":
      return onRunStarted(state, evt, runId);
    case "RUN_FINISHED":
      return onRunFinished(state, evt);
    case "RUN_ERROR":
      return onRunError(state, evt);
    case "REASONING_MESSAGE_START":
      return onReasoningStart(state, evt, runId);
    case "REASONING_MESSAGE_CONTENT":
      return onReasoningContent(state, evt);
    case "REASONING_MESSAGE_END":
      return closeStep(state, messageStepId(evt.messageId), nowTs(evt), evt);
    case "TEXT_MESSAGE_START":
      return onTextStart(state, evt, runId);
    case "TEXT_MESSAGE_CONTENT":
      return onTextContent(state, evt);
    case "TEXT_MESSAGE_END":
      return closeStep(state, messageStepId(evt.messageId), nowTs(evt), evt);
    case "TOOL_CALL_START":
      return onToolStart(state, evt, runId);
    case "TOOL_CALL_ARGS":
      return onToolArgs(state, evt);
    case "TOOL_CALL_END":
      // Tool emitted; awaiting result. Keep status running, just log.
      return logToStep(state, toolStepId(evt.toolCallId), evt);
    case "TOOL_CALL_RESULT":
      return onToolResult(state, evt);
    case "STATE_SNAPSHOT":
    case "STATE_DELTA":
      // Plan/state mutations: logged on the root step's feed. Task graph is
      // driven by relay.task_graph CUSTOM events, so we don't synthesize
      // plan steps from STATE here (avoids double-source-of-truth).
      return logToRoot(state, evt);
    case "CUSTOM":
      return applyCustom(state, evt, { makeStep, upsertStep, appendEvent });
    default:
      return logToRoot(state, evt);
  }
}

// ---------------------------------------------------------------- handlers

function onRunStarted(
  state: ReducerState,
  evt: RunStartedEvent,
  runId: string,
): ReducerState {
  const id = runId || evt.runId || `run-${Date.now()}`;
  const step = makeStep({
    id,
    run_id: id,
    kind: "run",
    status: "running",
    title: "Run",
    started_at: nowTs(evt),
  });
  step.events = [evt];
  const next = upsertStep({ ...state, rootStepId: id }, step);
  return { ...next, rootStepId: id };
}

function onRunFinished(state: ReducerState, evt: RunFinishedEvent): ReducerState {
  // Interrupt outcome → spawn one hitl step per interrupt so the dock can
  // render an approval/ask_user/diff card and the user can resume.
  if (evt.outcome?.type === "interrupt") {
    let next = state;
    for (const it of evt.outcome.interrupts) {
      const id = `hitl:${it.id}`;
      const step = makeStep({
        id,
        run_id: extractRelayMeta(evt).run_id,
        kind: "hitl",
        status: "review",
        title: it.message || it.reason || "Needs your input",
        started_at: nowTs(evt),
        parent_step_id: state.rootStepId ?? undefined,
      });
      step.hitl = {
        interruptId: it.id,
        reason: it.reason,
        message: it.message ?? undefined,
        metadata: it.metadata ?? undefined,
      };
      step.events = [evt];
      next = upsertStep(next, step);
    }
    // Root stays "running" while the user decides (the turn is paused,
    // not finished). isStreaming is flipped off by the store on this event.
    return next;
  }
  // Success: close the root step.
  if (state.rootStepId) {
    return closeStep(state, state.rootStepId, nowTs(evt), evt);
  }
  return logToRoot(state, evt);
}

function onRunError(state: ReducerState, evt: RunErrorEvent): ReducerState {
  if (!state.rootStepId) return logToRoot(state, evt);
  const step = state.steps.get(state.rootStepId);
  if (!step) return logToRoot(state, evt);
  const finished_at = nowTs(evt);
  const updated: Step = {
    ...step,
    status: "failed",
    finished_at,
    duration_ms: finished_at - step.started_at,
    events: appendEvent(step, evt),
  };
  return upsertStep(state, updated);
}

function onReasoningStart(
  state: ReducerState,
  evt: ReasoningMessageStartEvent,
  runId: string,
): ReducerState {
  const id = messageStepId(evt.messageId);
  const step = makeStep({
    id,
    run_id: runId,
    kind: "thinking",
    status: "running",
    title: "Thinking",
    started_at: nowTs(evt),
    parent_step_id: state.rootStepId ?? undefined,
  });
  step.reasoning_text = "";
  step.events = [evt];
  return upsertStep(state, step);
}

function onReasoningContent(
  state: ReducerState,
  evt: ReasoningMessageContentEvent,
): ReducerState {
  const id = messageStepId(evt.messageId);
  const step = state.steps.get(id);
  if (!step) {
    // Content before start (rare) — synthesize the step lazily.
    const created = makeStep({
      id,
      run_id: extractRelayMeta(evt).run_id,
      kind: "thinking",
      status: "running",
      title: "Thinking",
      started_at: nowTs(evt),
      parent_step_id: state.rootStepId ?? undefined,
    });
    created.reasoning_text = evt.delta;
    created.events = [evt];
    return upsertStep(state, created);
  }
  const updated: Step = {
    ...step,
    reasoning_text: (step.reasoning_text ?? "") + evt.delta,
    events: appendEvent(step, evt),
  };
  return upsertStep(state, updated);
}

function onTextStart(
  state: ReducerState,
  evt: TextMessageStartEvent,
  runId: string,
): ReducerState {
  const id = messageStepId(evt.messageId);
  const step = makeStep({
    id,
    run_id: runId,
    kind: "assistant_text",
    status: "running",
    title: "Vantage",
    started_at: nowTs(evt),
    parent_step_id: state.rootStepId ?? undefined,
  });
  step.text = "";
  step.events = [evt];
  return upsertStep(state, step);
}

function onTextContent(
  state: ReducerState,
  evt: TextMessageContentEvent,
): ReducerState {
  const id = messageStepId(evt.messageId);
  const step = state.steps.get(id);
  if (!step) {
    const created = makeStep({
      id,
      run_id: extractRelayMeta(evt).run_id,
      kind: "assistant_text",
      status: "running",
      title: "Vantage",
      started_at: nowTs(evt),
      parent_step_id: state.rootStepId ?? undefined,
    });
    created.text = evt.delta;
    created.events = [evt];
    return upsertStep(state, created);
  }
  const updated: Step = {
    ...step,
    text: (step.text ?? "") + evt.delta,
    events: appendEvent(step, evt),
  };
  return upsertStep(state, updated);
}

function onToolStart(
  state: ReducerState,
  evt: ToolCallStartEvent,
  runId: string,
): ReducerState {
  const id = toolStepId(evt.toolCallId);
  const step = makeStep({
    id,
    run_id: runId,
    kind: "tool",
    status: "running",
    title: evt.toolCallName,
    started_at: nowTs(evt),
    parent_step_id: state.rootStepId ?? undefined,
  });
  step.tool = { name: evt.toolCallName, args: "" };
  step.events = [evt];
  return upsertStep(state, step);
}

function onToolArgs(state: ReducerState, evt: ToolCallArgsEvent): ReducerState {
  const id = toolStepId(evt.toolCallId);
  const step = state.steps.get(id);
  if (!step || !step.tool) return logToStep(state, id, evt);
  // args streams as a JSON string delta; we accumulate the raw string and
  // attempt a parse at the end (TOOL_CALL_RESULT) — but keep the partial
  // string available so the card can show it live.
  const prevArgs = typeof step.tool.args === "string" ? step.tool.args : "";
  const updated: Step = {
    ...step,
    tool: { ...step.tool, args: prevArgs + evt.delta },
    events: appendEvent(step, evt),
  };
  return upsertStep(state, updated);
}

function onToolResult(
  state: ReducerState,
  evt: ToolCallResultEvent,
): ReducerState {
  const id = toolStepId(evt.toolCallId);
  const step = state.steps.get(id);
  if (!step) {
    // Result without a start — synthesize a done tool step.
    const created = makeStep({
      id,
      run_id: extractRelayMeta(evt).run_id,
      kind: "tool",
      status: "done",
      title: "tool",
      started_at: nowTs(evt),
      parent_step_id: state.rootStepId ?? undefined,
    });
    created.tool = { name: "tool", result: parseMaybeJson(evt.content) };
    created.finished_at = nowTs(evt);
    created.events = [evt];
    return upsertStep(state, created);
  }
  const finished_at = nowTs(evt);
  const parsedArgs = step.tool?.args
    ? parseMaybeJson(
        typeof step.tool.args === "string"
          ? step.tool.args
          : JSON.stringify(step.tool.args),
      )
    : undefined;
  const updated: Step = {
    ...step,
    status: "done",
    finished_at,
    duration_ms: finished_at - step.started_at,
    tool: {
      name: step.tool?.name ?? "tool",
      args: parsedArgs,
      result: parseMaybeJson(evt.content),
    },
    events: appendEvent(step, evt),
  };
  return upsertStep(state, updated);
}

// ---------------------------------------------------------------- shared

function closeStep(
  state: ReducerState,
  id: string,
  finished_at: number,
  evt: AgentEvent,
): ReducerState {
  const step = state.steps.get(id);
  if (!step) return logToRoot(state, evt);
  const updated: Step = {
    ...step,
    status: step.status === "failed" ? "failed" : "done",
    finished_at,
    duration_ms: finished_at - step.started_at,
    events: appendEvent(step, evt),
  };
  return upsertStep(state, updated);
}

function logToStep(
  state: ReducerState,
  id: string,
  evt: AgentEvent,
): ReducerState {
  const step = state.steps.get(id);
  if (!step) return logToRoot(state, evt);
  return upsertStep(state, { ...step, events: appendEvent(step, evt) });
}

function logToRoot(state: ReducerState, evt: AgentEvent): ReducerState {
  if (!state.rootStepId) return state;
  const root = state.steps.get(state.rootStepId);
  if (!root) return state;
  return upsertStep(state, { ...root, events: appendEvent(root, evt) });
}

// Parse a string that *might* be JSON; return the original string on
// failure so a non-JSON tool result still renders.
function parseMaybeJson(s: unknown): unknown {
  if (typeof s !== "string") return s;
  const trimmed = s.trim();
  if (!trimmed) return s;
  if (!/^[[{"]/.test(trimmed) && !/^-?\d/.test(trimmed)) return s;
  try {
    return JSON.parse(trimmed);
  } catch {
    return s;
  }
}
