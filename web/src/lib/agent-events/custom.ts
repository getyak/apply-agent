/**
 * custom.ts — second-level dispatch for AG-UI CUSTOM events. The reducer
 * hands every `type === "CUSTOM"` event here; we switch on `event.name`
 * (a closed `relay.*` namespace, see schema.ts:RelayCustomName) and fold
 * the payload into the relevant Step.
 *
 * Why a separate file (not inline in reducer.ts)
 * ----------------------------------------------
 * The CUSTOM namespace is where Relay's product-specific event types live
 * (task graph, narrator, agent group, file_edit, browser snapshot). Keeping
 * the relay.* routing here means the reducer's core stays a clean AG-UI
 * state machine, and a future spec upgrade that promotes file_edit /
 * browser_snapshot into *standard* events only changes one dispatch site
 * (agent-event-stream.md §3.3).
 *
 * Unknown relay.* names: logged once via console.warn and dropped into the
 * root step's events feed, never rendered. This keeps forward compatibility
 * — agents can ship a new relay.* event before the web reducer knows it.
 *
 * Caller: web/src/lib/agent-events/reducer.ts (the CUSTOM case of
 * applyEvent). The reducer passes a small helper bag so this module never
 * imports the reducer back (avoids a runtime circular import).
 */

import type {
  AgentEvent,
  BrowserAction,
  BrowserSnapshot,
  CustomEvent,
  FileEditHunk,
  Step,
  StepKind,
} from "./schema";
import { extractRelayMeta } from "./relay-meta";

// Helper bag passed down from reducer.ts. Only pure functions are shared.
export interface ReducerHelpers {
  makeStep: (p: {
    id: string;
    kind: StepKind;
    status: Step["status"];
    title: string;
    started_at: number;
    parent_step_id?: string;
    run_id?: string;
  }) => Step;
  upsertStep: (state: CustomState, step: Step) => CustomState;
  appendEvent: (step: Step, evt: AgentEvent) => AgentEvent[];
}

// Structural mirror of reducer.ReducerState — declared here to avoid the
// circular type import. The two are the same object shape.
export interface CustomState {
  steps: Map<string, Step>;
  order: string[];
  rootStepId: string | null;
}

function nowTs(evt: AgentEvent): number {
  return typeof evt.timestamp === "number" ? evt.timestamp : Date.now();
}

// A CUSTOM event's step id when none of the typed handlers apply: prefer the
// explicit relay step_id; fall back to a name+seq synthetic id so events
// without a step_id (e.g. a one-shot narrator) still get a stable home.
function customStepId(
  evt: CustomEvent,
  meta: Record<string, unknown> & { step_id?: string },
): string {
  if (meta.step_id) return `custom:${meta.step_id}`;
  const seq = typeof meta.seq === "number" ? String(meta.seq) : "0";
  return `custom:${evt.name}:${seq}`;
}

export function applyCustom(
  state: CustomState,
  evt: CustomEvent,
  h: ReducerHelpers,
): CustomState {
  const meta = extractRelayMeta(evt as AgentEvent);
  switch (evt.name) {
    case "relay.task_graph":
      return onTaskGraph(state, evt, meta, h);
    case "relay.task_graph_step":
      return onTaskGraphStep(state, evt, h);
    case "relay.agent_start":
      return onAgentStart(state, evt, meta, h);
    case "relay.agent_done":
      return onAgentDone(state, evt, meta, h);
    case "relay.agents_group":
      // Group wrapper carries no own UI in the step model — children render
      // as individual agent_start/done steps. Log on root.
      return logToRoot(state, evt as AgentEvent, h);
    case "relay.narrator":
      return onNarrator(state, evt, meta, h);
    case "relay.partial_artifact":
      return onPartialArtifact(state, evt, meta, h);
    case "relay.artifact":
      return onArtifact(state, evt, meta, h);
    case "relay.hitl_prep":
      // Preparatory HITL signal — the actual interrupt arrives as
      // RUN_FINISHED(outcome=interrupt). Just log so the feed has context.
      return logToRoot(state, evt as AgentEvent, h);
    case "relay.file_edit":
    case "relay.file_edit.preview":
      return onFileEdit(state, evt, meta, h);
    case "relay.browser_snapshot":
    case "relay.browser_action":
      return onBrowser(state, evt, meta, h);
    default:
      // Unknown relay.* name — forward-compat: log once, drop into root feed.
      // Cast because TS narrows `name` to `never` after the exhaustive cases;
      // at runtime a newer agent may emit an unlisted name.
      console.warn(
        `[agent-events] unknown CUSTOM name: ${(evt as CustomEvent).name}`,
      );
      return logToRoot(state, evt as AgentEvent, h);
  }
}

// ---------------------------------------------------------------- task graph

interface TaskGraphPayload {
  task_id?: string;
  user_goal?: string;
  plan?: Array<{
    step: number | string;
    agent?: string;
    label?: string;
    status?: string;
    requires_review?: boolean;
  }>;
}

function onTaskGraph(
  state: CustomState,
  evt: CustomEvent,
  meta: { run_id: string },
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as TaskGraphPayload;
  const id = v.task_id ? `plan:${v.task_id}` : "plan:current";
  const step = h.makeStep({
    id,
    run_id: meta.run_id,
    kind: "plan",
    status: "running",
    title: v.user_goal || "Plan",
    started_at: nowTs(evt as AgentEvent),
    parent_step_id: state.rootStepId ?? undefined,
  });
  step.plan = {
    taskId: v.task_id ?? "current",
    userGoal: v.user_goal,
    steps: (v.plan ?? []).map((p) => ({
      step: String(p.step),
      agent: p.agent ?? "",
      label: p.label ?? "",
      status: normalizePlanStatus(p.status),
      requiresReview: !!p.requires_review,
    })),
  };
  step.events = [evt as AgentEvent];
  // Replace an existing plan step in place (later snapshots supersede).
  return h.upsertStep(state, step);
}

interface TaskGraphStepPayload {
  task_id?: string;
  step: number | string;
  status?: string;
  error?: string;
}

function onTaskGraphStep(
  state: CustomState,
  evt: CustomEvent,
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as TaskGraphStepPayload;
  const id = v.task_id ? `plan:${v.task_id}` : "plan:current";
  const step = state.steps.get(id);
  if (!step || !step.plan) return logToRoot(state, evt as AgentEvent, h);
  const targetStep = String(v.step);
  const nextStatus = normalizePlanStatus(v.status);
  const updated: Step = {
    ...step,
    plan: {
      ...step.plan,
      steps: step.plan.steps.map((s) =>
        s.step === targetStep
          ? {
              ...s,
              // Don't walk a terminal step back to running.
              status:
                s.status === "done" || s.status === "failed"
                  ? s.status
                  : nextStatus,
              errorText: v.error ?? s.errorText,
            }
          : s,
      ),
    },
    events: h.appendEvent(step, evt as AgentEvent),
  };
  return h.upsertStep(state, updated);
}

function normalizePlanStatus(
  s: string | undefined,
): "pending" | "running" | "done" | "review" | "failed" {
  switch (s) {
    case "running":
    case "done":
    case "review":
    case "failed":
      return s;
    default:
      return "pending";
  }
}

// ---------------------------------------------------------------- agents

interface AgentPayload {
  agent?: string;
  label?: string;
  status_text?: string;
}

function onAgentStart(
  state: CustomState,
  evt: CustomEvent,
  meta: { step_id?: string; run_id: string },
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as AgentPayload;
  const id = meta.step_id
    ? `agent:${meta.step_id}`
    : `agent:${v.agent ?? "x"}:${nowTs(evt as AgentEvent)}`;
  const step = h.makeStep({
    id,
    run_id: meta.run_id,
    kind: "tool",
    status: "running",
    title: v.label || v.agent || "agent",
    started_at: nowTs(evt as AgentEvent),
    parent_step_id: state.rootStepId ?? undefined,
  });
  step.tool = { name: v.agent ?? "agent" };
  step.events = [evt as AgentEvent];
  return h.upsertStep(state, step);
}

function onAgentDone(
  state: CustomState,
  evt: CustomEvent,
  meta: { step_id?: string; run_id: string },
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as AgentPayload;
  // Resolve the matching running agent step by step_id, else by agent name.
  let id = meta.step_id ? `agent:${meta.step_id}` : null;
  if (!id) {
    for (let i = state.order.length - 1; i >= 0; i--) {
      const s = state.steps.get(state.order[i]);
      if (
        s &&
        s.kind === "tool" &&
        s.tool?.name === v.agent &&
        s.status === "running"
      ) {
        id = s.id;
        break;
      }
    }
  }
  if (!id) return logToRoot(state, evt as AgentEvent, h);
  const step = state.steps.get(id);
  if (!step) return logToRoot(state, evt as AgentEvent, h);
  const finished_at = nowTs(evt as AgentEvent);
  const updated: Step = {
    ...step,
    status: "done",
    finished_at,
    duration_ms: finished_at - step.started_at,
    events: h.appendEvent(step, evt as AgentEvent),
  };
  return h.upsertStep(state, updated);
}

// ---------------------------------------------------------------- narrator

function onNarrator(
  state: CustomState,
  evt: CustomEvent,
  meta: Record<string, unknown> & { step_id?: string; run_id: string },
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as { text?: string };
  const text = (v.text ?? "").trim();
  if (!text) return logToRoot(state, evt as AgentEvent, h);
  const id = customStepId(evt, meta);
  const step = h.makeStep({
    id,
    run_id: meta.run_id,
    kind: "narrator",
    status: "done",
    title: "Narrator",
    started_at: nowTs(evt as AgentEvent),
    parent_step_id: state.rootStepId ?? undefined,
  });
  step.narrator = { text };
  step.events = [evt as AgentEvent];
  return h.upsertStep(state, step);
}

// ---------------------------------------------------------------- artifacts

interface ArtifactPayload {
  id?: string;
  artifact_id?: string;
  artifact_kind?: string;
  title?: string;
  sub?: string;
  progress?: number;
  snapshot?: unknown;
  payload?: unknown;
}

function onPartialArtifact(
  state: CustomState,
  evt: CustomEvent,
  meta: { run_id: string },
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as ArtifactPayload;
  const artifactId = v.artifact_id ?? v.id ?? "artifact";
  const id = `artifact:${artifactId}`;
  const existing = state.steps.get(id);
  const base =
    existing ??
    h.makeStep({
      id,
      run_id: meta.run_id,
      kind: "artifact",
      status: "running",
      title: v.title || "Drafting",
      started_at: nowTs(evt as AgentEvent),
      parent_step_id: state.rootStepId ?? undefined,
    });
  const updated: Step = {
    ...base,
    status: "running",
    title: v.title || base.title,
    artifact: {
      id: artifactId,
      snapshot: v.payload ?? v.snapshot ?? base.artifact?.snapshot ?? null,
    },
    events: existing
      ? h.appendEvent(base, evt as AgentEvent)
      : [evt as AgentEvent],
  };
  return h.upsertStep(state, updated);
}

function onArtifact(
  state: CustomState,
  evt: CustomEvent,
  meta: { run_id: string },
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as ArtifactPayload;
  const artifactId = v.artifact_id ?? v.id ?? "artifact";
  const id = `artifact:${artifactId}`;
  const existing = state.steps.get(id);
  const base =
    existing ??
    h.makeStep({
      id,
      run_id: meta.run_id,
      kind: "artifact",
      status: "done",
      title: v.title || "Artifact",
      started_at: nowTs(evt as AgentEvent),
      parent_step_id: state.rootStepId ?? undefined,
    });
  const finished_at = nowTs(evt as AgentEvent);
  const updated: Step = {
    ...base,
    status: "done",
    title: v.title || base.title,
    finished_at,
    duration_ms: finished_at - base.started_at,
    artifact: { id: artifactId, snapshot: v.payload ?? v.snapshot ?? v },
    events: existing
      ? h.appendEvent(base, evt as AgentEvent)
      : [evt as AgentEvent],
  };
  return h.upsertStep(state, updated);
}

// ---------------------------------------------------------------- file_edit

interface FileEditPayload {
  path: string;
  language?: string;
  hunks?: FileEditHunk[];
  before?: string;
  after?: string;
  applied?: boolean;
}

function onFileEdit(
  state: CustomState,
  evt: CustomEvent,
  meta: { step_id?: string; run_id: string },
  h: ReducerHelpers,
): CustomState {
  const v = evt.value as FileEditPayload;
  // Group preview + final under the same step (keyed by step_id or path).
  const key = meta.step_id ?? v.path;
  const id = `file:${key}`;
  const existing = state.steps.get(id);
  const isPreview = evt.name === "relay.file_edit.preview";
  // Build hunks: a `.preview` carries before/after directly; a final
  // `relay.file_edit` carries a hunks[] array (or before/after fallback).
  const hunks: FileEditHunk[] =
    v.hunks && v.hunks.length > 0
      ? v.hunks
      : v.before !== undefined || v.after !== undefined
        ? [{ before: v.before ?? "", after: v.after ?? "" }]
        : (existing?.file?.hunks ?? []);
  const base =
    existing ??
    h.makeStep({
      id,
      run_id: meta.run_id,
      kind: "file_edit",
      status: isPreview ? "running" : "done",
      title: v.path,
      started_at: nowTs(evt as AgentEvent),
      parent_step_id: state.rootStepId ?? undefined,
    });
  const finished_at = isPreview ? undefined : nowTs(evt as AgentEvent);
  const updated: Step = {
    ...base,
    status: isPreview ? "running" : "done",
    title: v.path || base.title,
    finished_at,
    duration_ms: finished_at ? finished_at - base.started_at : base.duration_ms,
    file: {
      path: v.path,
      language: v.language ?? base.file?.language ?? "text",
      hunks,
      applied: v.applied ?? (!isPreview ? true : (base.file?.applied ?? false)),
    },
    events: existing
      ? h.appendEvent(base, evt as AgentEvent)
      : [evt as AgentEvent],
  };
  return h.upsertStep(state, updated);
}

// ---------------------------------------------------------------- browser

interface BrowserSnapshotPayload {
  url: string;
  screenshot_url?: string;
  viewport?: { w: number; h: number };
  accessibility_tree?: unknown;
}
interface BrowserActionPayload {
  action: "click" | "fill" | "navigate";
  target: string;
  value?: string;
}

function onBrowser(
  state: CustomState,
  evt: CustomEvent,
  meta: { step_id?: string; run_id: string },
  h: ReducerHelpers,
): CustomState {
  const id = `browser:${meta.step_id ?? "current"}`;
  const existing = state.steps.get(id);
  const base =
    existing ??
    h.makeStep({
      id,
      run_id: meta.run_id,
      kind: "browser",
      status: "running",
      title: "Browser",
      started_at: nowTs(evt as AgentEvent),
      parent_step_id: state.rootStepId ?? undefined,
    });
  const snapshots: BrowserSnapshot[] = [...(base.browser?.snapshots ?? [])];
  const actions: BrowserAction[] = [...(base.browser?.actions ?? [])];
  if (evt.name === "relay.browser_snapshot") {
    const v = evt.value as BrowserSnapshotPayload;
    snapshots.push({
      url: v.url,
      screenshotUrl: v.screenshot_url ?? "",
      viewport: v.viewport ?? { w: 0, h: 0 },
      accessibilityTree: v.accessibility_tree,
      ts: nowTs(evt as AgentEvent),
    });
  } else {
    const v = evt.value as BrowserActionPayload;
    actions.push({
      action: v.action,
      target: v.target,
      value: v.value,
      ts: nowTs(evt as AgentEvent),
    });
  }
  const lastUrl =
    snapshots.length > 0 ? snapshots[snapshots.length - 1].url : base.title;
  const updated: Step = {
    ...base,
    title: lastUrl || "Browser",
    browser: { snapshots, actions },
    events: existing
      ? h.appendEvent(base, evt as AgentEvent)
      : [evt as AgentEvent],
  };
  return h.upsertStep(state, updated);
}

// ---------------------------------------------------------------- shared

function logToRoot(
  state: CustomState,
  evt: AgentEvent,
  h: ReducerHelpers,
): CustomState {
  if (!state.rootStepId) return state;
  const root = state.steps.get(state.rootStepId);
  if (!root) return state;
  return h.upsertStep(state, { ...root, events: h.appendEvent(root, evt) });
}
