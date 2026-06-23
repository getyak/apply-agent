// Ask Vantage SSE client.
//
// Two layers:
//   1. runAskStream — low-level. Pulls from POST /api/ask/stream, parses
//      NDJSON frames, runs an idle watchdog, calls back into whatever state
//      pool the caller manages. Knows nothing about useDock or React.
//   2. sendAsk — dock wrapper. Wires runAskStream's callbacks into useDock
//      and is the only caller that mutates the dock's message list /
//      agentEvents / streaming flag.
//
// The Resume Studio vibe chat (vantage-ui-mapping.md §2.6) drives
// runAskStream directly with local-component callbacks so its messages
// live in component state, not the dock.
//
// Frame contract (line-delimited JSON, one frame per line):
//   { "kind": "text",        "delta": "..." }
//   { "kind": "agent_start", "agent": "resume_agent",
//     "label": "RÉSUMÉ AGENT · drafting v7" }
//   { "kind": "agent_done",  "agent": "resume_agent",
//     "statusText": "v7 saved" }
//   { "kind": "result",      "title": "...", "sub": "...",
//     "action": "Open résumé", "route": "/app/studio/resume" }
//   { "kind": "done" }
//   { "kind": "error",       "message": "..." }
//
// We use NDJSON rather than `text/event-stream` framing for two
// reasons: (a) SSE's `data:` prefix doubles transport bytes once
// payloads grow with full agent traces; (b) we want raw JSON so the
// api gateway can pass FastAPI's astream_events through with
// minimal munging.

import { getToken } from "./api";
import { getClientLocale } from "@/i18n/locale-client";
import { API_BASE } from "./api-base";
import {
  useDock,
  type AgentEvent,
  type DockAttachment,
} from "./ask-vantage-store";

// One step in the coordinator's plan. agent_id matches the same `agent`
// string carried on agent_start/agent_done so the UI can light up each
// row as the run progresses. requires_review is the audit's HITL signal
// — the UI marks the step with a "review" pill instead of auto-green.
export interface TaskGraphStep {
  step: string;            // stable identifier (e.g. "customize_resume")
  agent: string;           // the agent that will run this step
  label: string;           // human-facing one-liner
  requires_review?: boolean;
}

export interface TaskGraph {
  task_id: string;
  user_goal: string;
  plan: TaskGraphStep[];
}

// A typed reference back to where this artifact lives once the user
// approves it — used by both the View-evidence link and the redirect
// after Approve.
export type ArtifactType =
  | "resume_version"
  | "job_match_set"
  | "application_package"
  | "interview_session"
  | "cover_letter"
  | "market_snapshot"
  // Dual-track suggestion stack (design §6.3) — accept/reject inline in dock.
  | "suggestion_list";

// One AI suggestion in a suggestion_list artifact.
export interface ArtifactSuggestion {
  id: string;
  bullet_stable_id: string | null;
  section: string | null;
  change_type: string;
  before_text: string;
  after_text: string;
  rationale: string | null;
  risk_level: "safe" | "needs_review" | "unsupported";
}

export interface SourceEvidence {
  // Short, user-facing description (e.g. "Stripe JD · staff eng · 2026-04-12")
  label: string;
  // Optional same-origin route to view the evidence. ask-stream re-uses
  // isSafeRoute before exposing it to the dock.
  route?: string;
}

export interface ArtifactAction {
  // One of "approve" | "tweak" | "discard" | "open". The dock renders
  // approve in brown (primary), discard in muted red, tweak as a neutral
  // outline button, and open as the default CTA.
  kind: "approve" | "tweak" | "discard" | "open";
  label: string;
  route?: string;
}

export interface Artifact {
  artifact_type: ArtifactType;
  id: string;
  title: string;
  sub: string;
  // 0–1 produced by the agent. Anything < 0.6 paints a yellow "low
  // confidence" pill; the dock still renders the actions.
  confidence?: number;
  // True iff the artifact MUST get an explicit user approval before any
  // side-effect (submit / send / write). Plays into vision.md's HITL
  // red-line: submit / send / delete always need approval.
  needs_user_review?: boolean;
  source_evidence?: SourceEvidence[];
  next_actions?: ArtifactAction[];
  // Only present on suggestion_list artifacts.
  suggestions?: ArtifactSuggestion[];
  source_resume_id?: string;
}

// Inline-HITL frames (P1-C) — emitted when dock_agent hits
// LangGraph's interrupt(). The dock collects the user's decision and
// POSTs it to /api/ask/resume with resume_token. The UI render layer
// for these ships in a separate PR; the protocol is stable now so
// agents can start emitting them.
export interface AskUserFrame {
  kind: "ask_user";
  question: string;
  chips?: string[];
  free_form?: boolean;
  resume_token: string;
}
export interface DiffFrame {
  kind: "diff";
  before: unknown;
  after: unknown;
  resume_token: string;
}
export interface ApprovalFrame {
  kind: "approval";
  action: string;
  payload: unknown;
  resume_token: string;
}

type StreamFrame =
  | { kind: "text"; delta: string }
  // Provider chain-of-thought delta. Only emitted when the picked tier
  // honors OpenRouter's `reasoning` passthrough (DeepSeek V4 Pro / GLM-
  // 4.7); V4 Flash drops these so the dock's Thinking body stays empty
  // for cheap-tier turns. Always additive — pre-reasoning clients
  // (e.g. older extension builds) hit the default branch and ignore it.
  | { kind: "reasoning_delta"; text: string }
  | { kind: "task_graph"; graph: TaskGraph }
  // Step 1 — italic "thought-aloud" chip the dock_agent emits immediately
  // before each execution tool. One short user-facing sentence; no CoT.
  | { kind: "narrator"; text: string }
  // Step 3 — collapsible tool console row. One per finished execution
  // tool (system tools like propose_plan / recall_* are hidden upstream).
  // The row shows tool + 1-line summary + duration; expanded view shows
  // the full result (the dock derives the result from the matching
  // `artifact` / `result` frame that arrives in the same tick).
  | {
      kind: "tool_trace";
      tool: string;
      agent: string;
      action: string;
      status: "ok" | "error";
      summary: string;
      plan_step?: string;
      // Inline-detail upgrade: raw input + (server-capped) output. Both
      // optional so older Python backends still parse cleanly.
      args?: unknown;
      result?: unknown;
    }
  // Step 4 — `plan_step` is optional (only present when the dock_agent
  // path is on AND the model called a plan-aligned tool). Older legacy
  // frames without it just don't highlight a plan row.
  | { kind: "agent_start"; agent: string; label: string; plan_step?: string }
  | {
      kind: "agent_done";
      agent: string;
      statusText: string;
      plan_step?: string;
    }
  | { kind: "agent_failed"; agent: string; statusText: string; plan_step?: string }
  | {
      kind: "result";
      title: string;
      sub: string;
      action: string;
      route?: string;
    }
  | { kind: "artifact"; artifact: Artifact }
  // Step 5 — in-flight artifact snapshot. The dock merges by artifact_id;
  // a `kind: "artifact"` frame later supersedes the partial.
  | {
      kind: "partial_artifact";
      artifact_id: string;
      artifact_kind: string;
      title?: string;
      sub?: string;
      progress?: number;
      payload?: unknown;
    }
  | AskUserFrame
  | DiffFrame
  | ApprovalFrame
  | { kind: "done" }
  // SSE4 (round-9): `code` and `trace_id` come from the Python global
  // exception envelope (round-5 API1/API2) and are forwarded by the
  // gateway (api/src/routes/ask.ts). The dock branches on `code` so it
  // can disable retry UI for `budget_exhausted`, prompt re-auth on
  // `http_403`, and surface trace_id in support copy.
  | {
      kind: "error";
      message: string;
      code?: string;
      trace_id?: string;
    };

const AGENT_LABELS: Record<string, string> = {
  resume_agent: "RÉSUMÉ AGENT",
  jobmatch_agent: "SCOUT AGENT",
  interview_agent: "INTERVIEW AGENT",
  appprep_agent: "APPLICATION AGENT",
  trend_agent: "TREND AGENT",
  coordinator: "COORDINATOR",
};

function endpoint(): string {
  // Shares the single API_BASE resolver with api.ts (see api-base.ts).
  // Matches api/src/config.ts API_PORT default (3001); override in deployment
  // via NEXT_PUBLIC_API_BASE (or the NEXT_PUBLIC_API_URL alias).
  return `${API_BASE}/api/ask/stream`;
}

// Whole-stream watchdog. Reset on every received chunk so a slow but
// progressing stream isn't killed; only fires when the connection
// stalls (no bytes) for this long.
const STREAM_IDLE_TIMEOUT_MS = 120_000;

// Only navigate to same-origin relative routes ("/foo"). Reject
// absolute URLs, protocol-relative ("//evil.com") and anything that
// isn't an in-app path — defends against open-redirect via result frame.
function isSafeRoute(route: string): boolean {
  return (
    typeof route === "string" &&
    route.startsWith("/") &&
    !route.startsWith("//")
  );
}

// Gateway non-2xx envelope. Both AGENT_UNREACHABLE (503) and AGENT_FAILED
// (502) share this shape; `code` is informational, `hint` is the user-
// facing copy we want to render verbatim.
interface AskErrorPayload {
  error?: string;
  code?: string;
  hint?: string;
  detail?: string;
  status?: number;
}

async function readErrorPayload(res: Response): Promise<AskErrorPayload | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as AskErrorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function formatAttachmentsFooter(atts: DockAttachment[]): string {
  if (atts.length === 0) return "";
  // Carried as a human-readable footer until /api/ask/stream grows a
  // structured attachments field. Agent prompts already tolerate trailing
  // [Attached: ...] lines (resume parse / customise flows).
  const lines = atts.map((a) => `- ${a.name} (file_id: ${a.id})`);
  return `\n\n[Attached files]\n${lines.join("\n")}`;
}

// ─── Surface ───────────────────────────────────────────────────────────

// Surface identifies which conversation panel is asking. See
// vantage-ui-mapping.md §2.6 for the channel split. Default to "dock"
// when omitted — keeps the lifetime conversation behavior intact for the
// 99% of caller sites that don't know about surfaces.
export type AskSurface = "dock" | "resume_studio" | "mock_studio" | "applications";

export interface SendAskOptions {
  surface?: AskSurface;
  // threadIdOverride lets a per-surface caller (e.g. the resume studio
  // vibe chat with its `resume_studio:{user_id}:{root_id}` thread) bypass
  // the dock's thread without poking at useDock internals. When unset,
  // we read useDock.threadId (the lifetime ask_vantage thread).
  threadIdOverride?: string;
}

// ─── Low-level runner ──────────────────────────────────────────────────

export interface AskStreamCallbacks {
  // Streaming text delta for the current assistant turn.
  onAssistantDelta: (delta: string) => void;
  // Step 1 — italic "thought-aloud" chip. Fires once before each execution
  // tool. Optional: if the caller doesn't render narrator chips we just
  // drop the frame (no behaviour regression).
  onNarrator?: (text: string) => void;
  // Step 3 — collapsible "tool console" row. Optional. Drops silently
  // when the caller doesn't consume it.
  onToolTrace?: (frame: {
    tool: string;
    agent: string;
    action: string;
    status: "ok" | "error";
    summary: string;
    planStep?: string;
    // Inline-detail upgrade: raw tool input + (capped) output. Optional —
    // older Python backends won't ship them, in which case the dock's
    // ToolTraceRow keeps its prior metadata-only expand panel.
    args?: unknown;
    result?: unknown;
  }) => void;
  // Provider chain-of-thought delta. Fires only when the picked tier
  // honours OpenRouter's `reasoning` passthrough (DeepSeek V4 Pro / GLM-
  // 4.7). Optional: callers that don't want to render reasoning just
  // omit the handler and the lane is dropped silently.
  onReasoning?: (text: string) => void;
  // Coordinator's plan for the current turn. Fires once, before any
  // agent_start. The dock renders it as a task-graph card so users see
  // *what's about to happen* instead of waiting for opaque agent spinners.
  // For backwards compatibility callers may omit this — runAskStream
  // silently swallows task_graph frames when no callback is provided.
  onTaskGraph?: (graph: TaskGraph) => void;
  // Agent task card lifecycle. Step 4 added the optional `planStep` arg so
  // the dock can highlight the matching task-graph row deterministically
  // (the dock_agent path stamps it on the wire). Callers that don't want
  // to use it just ignore the second/third positional.
  onAgentStart: (agent: string, label: string, planStep?: string) => void;
  onAgentDone: (agent: string, statusText: string, planStep?: string) => void;
  onAgentFailed: (agent: string, statusText: string, planStep?: string) => void;
  // Final result card. `route` is pre-validated as same-origin relative;
  // the caller decides whether to render a button that navigates there.
  onResult: (result: {
    title: string;
    sub: string;
    action: string;
    route?: string;
  }) => void;
  // Rich artifact emission — supersedes onResult for new agents. Carries
  // confidence, evidence and primary actions so the dock can render an
  // "Approve / Tweak / Discard" card with traceability. When omitted by
  // the caller (e.g. Resume Studio's local callback flow) we silently
  // drop the frame, just like task_graph.
  onArtifact?: (artifact: Artifact) => void;
  // Step 5 — in-progress snapshot of an artifact. Optional. The dock
  // merges multiple snapshots into one live card by artifact_id; the
  // final `onArtifact` then supersedes it. Callers that don't render
  // partials drop the frame silently.
  onPartialArtifact?: (frame: {
    artifact_id: string;
    artifact_kind: string;
    title?: string;
    sub?: string;
    progress?: number;
    payload?: unknown;
  }) => void;
  // Inline-HITL callbacks (P1-C, optional). When the agent hits
  // LangGraph's interrupt(), the dock surfaces one of these instead of
  // navigating away. Callers that don't implement them drop the frame —
  // forward compatibility for clients that haven't shipped the dock UI
  // changes yet.
  onAskUser?: (frame: AskUserFrame) => void;
  onDiff?: (frame: DiffFrame) => void;
  onApproval?: (frame: ApprovalFrame) => void;
  // Stream terminated normally.
  onDone: () => void;
  // Stream failed mid-flight. `kind` lets the caller distinguish a clean
  // upstream "error" frame, a transport timeout/disconnect, or a gateway-
  // reported precondition failure (agent host offline → AGENT_UNREACHABLE,
  // upstream returned non-2xx → AGENT_FAILED) so it can surface different
  // copy. `unreachable` payloads carry the gateway's hint verbatim — the
  // dock renders it instead of the generic "Lost connection" copy so the
  // user knows whether to retry or check that the agents host is up.
  onError: (
    // SSE4 (round-9): two extra kinds derived from the upstream `code`
    // field — `budget` means the user can't retry until their session
    // budget recovers; `forbidden` means the request was authn/authz-
    // rejected and re-auth is the right next step. Callers that don't
    // care about the distinction can keep treating everything as
    // `"frame"`.
    kind: "frame" | "timeout" | "disconnect" | "unreachable" | "budget" | "forbidden",
    message: string,
    meta?: { code?: string; trace_id?: string },
  ) => void;
}

export interface RunAskStreamArgs {
  prompt: string;
  threadId: string;
  surface?: AskSurface;
  abortController: AbortController;
  callbacks: AskStreamCallbacks;
}

/**
 * Pulls one SSE conversation turn from POST /api/ask/stream and dispatches
 * decoded frames through the supplied callbacks. State-pool agnostic — the
 * caller decides where messages, agent cards, and the streaming flag live.
 */
export async function runAskStream({
  prompt,
  threadId,
  surface,
  abortController,
  callbacks,
}: RunAskStreamArgs): Promise<void> {
  const cb = callbacks;

  const handleFrame = (frame: StreamFrame): "continue" | "stop" => {
    switch (frame.kind) {
      case "text":
        cb.onAssistantDelta(frame.delta);
        return "continue";
      case "reasoning_delta":
        // Provider chain-of-thought. Drop silently for callers that
        // haven't opted in; the lane is purely additive.
        if (cb.onReasoning) cb.onReasoning(frame.text);
        return "continue";
      case "narrator":
        // Drop silently for callers that haven't opted in. Resume Studio's
        // local-callback flow doesn't render narrators yet; dropping keeps
        // the contract additive (same shape as task_graph above).
        if (cb.onNarrator) cb.onNarrator(frame.text);
        return "continue";
      case "tool_trace":
        if (cb.onToolTrace) {
          cb.onToolTrace({
            tool: frame.tool,
            agent: frame.agent,
            action: frame.action,
            status: frame.status,
            summary: frame.summary,
            planStep: frame.plan_step,
            args: frame.args,
            result: frame.result,
          });
        }
        return "continue";
      case "task_graph":
        // Silently drop if the caller didn't opt in. Resume Studio's
        // local-callback flow doesn't show graphs yet; dropping keeps
        // the contract additive.
        if (cb.onTaskGraph) cb.onTaskGraph(frame.graph);
        return "continue";
      case "agent_start":
        cb.onAgentStart(frame.agent, frame.label, frame.plan_step);
        return "continue";
      case "agent_done":
        cb.onAgentDone(frame.agent, frame.statusText, frame.plan_step);
        return "continue";
      case "agent_failed":
        cb.onAgentFailed(frame.agent, frame.statusText, frame.plan_step);
        return "continue";
      case "result":
        cb.onResult({
          title: frame.title,
          sub: frame.sub,
          action: frame.action,
          route: frame.route && isSafeRoute(frame.route) ? frame.route : undefined,
        });
        return "continue";
      case "partial_artifact":
        if (cb.onPartialArtifact) {
          cb.onPartialArtifact({
            artifact_id: frame.artifact_id,
            artifact_kind: frame.artifact_kind,
            title: frame.title,
            sub: frame.sub,
            progress: frame.progress,
            payload: frame.payload,
          });
        }
        return "continue";
      case "artifact":
        if (cb.onArtifact) {
          // Filter routes through isSafeRoute defensively — agents are
          // trusted, but the dock will render these as anchor hrefs that
          // navigate on click; same open-redirect surface as `result`.
          const a = frame.artifact;
          const safe: Artifact = {
            ...a,
            source_evidence: a.source_evidence?.map((e) => ({
              label: e.label,
              route: e.route && isSafeRoute(e.route) ? e.route : undefined,
            })),
            next_actions: a.next_actions?.map((n) => ({
              ...n,
              route: n.route && isSafeRoute(n.route) ? n.route : undefined,
            })),
          };
          cb.onArtifact(safe);
        }
        return "continue";
      case "ask_user":
        if (cb.onAskUser) cb.onAskUser(frame);
        return "continue";
      case "diff":
        if (cb.onDiff) cb.onDiff(frame);
        return "continue";
      case "approval":
        if (cb.onApproval) cb.onApproval(frame);
        return "continue";
      case "done":
        cb.onDone();
        return "stop";
      case "error": {
        // SSE4 (round-9): map upstream `code` to a more specific kind
        // when it matches a class the dock UI cares about; everything
        // else falls back to "frame" so existing callers keep working.
        const code = frame.code;
        let kind: "frame" | "budget" | "forbidden" = "frame";
        if (code === "budget_exhausted") kind = "budget";
        else if (code === "http_403") kind = "forbidden";
        cb.onError(kind, frame.message, {
          ...(frame.code !== undefined ? { code: frame.code } : {}),
          ...(frame.trace_id !== undefined ? { trace_id: frame.trace_id } : {}),
        });
        return "stop";
      }
      default:
        return "continue";
    }
  };

  const parseLine = (line: string): StreamFrame | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as StreamFrame;
    } catch {
      return null;
    }
  };

  // Idle watchdog: abort the whole stream if no chunk arrives within
  // STREAM_IDLE_TIMEOUT_MS. Reset on every received chunk so slow-but-
  // progressing streams survive. `timedOut` lets us surface a distinct
  // user-facing message instead of treating it as a generic disconnect.
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const token = getToken();
    armIdle();
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        prompt,
        thread_id: threadId,
        ...(surface ? { surface } : {}),
        // UI locale (en/zh) so the agent pins its reply language to the
        // user's chosen interface language instead of guessing from charset.
        locale: getClientLocale(),
      }),
      signal: abortController.signal,
    });

    if (!res.ok || !res.body) {
      // Gateway emits a structured JSON body with `code` + `hint` when
      // the agent host is unreachable (503) or upstream failed (502).
      // Surfacing the hint verbatim lets the dock show "Reasoning engine
      // is offline" instead of the generic "Lost connection. Try again."
      // — which is what the audit (P1 "Agent 流式协议") flagged.
      const payload = await readErrorPayload(res);
      if (payload?.hint) {
        cb.onError("unreachable", payload.hint);
        return;
      }
      throw new Error(
        `/api/ask/stream returned ${res.status}${payload?.detail ? `: ${payload.detail.slice(0, 200)}` : ""}`,
      );
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle(); // progressing — reset the watchdog
      buf += decoder.decode(value, { stream: true });

      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        const frame = parseLine(line);
        if (!frame) continue;
        if (handleFrame(frame) === "stop") return;
      }
    }

    // Stream ended without a trailing newline: flush any buffered final
    // frame so the last message isn't silently dropped.
    const tail = buf.trim();
    if (tail) {
      const frame = parseLine(tail);
      if (frame && handleFrame(frame) === "stop") return;
    }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    if (timedOut) {
      cb.onError("timeout", "Vantage stream timed out. Try again.");
    } else if (!aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      cb.onError("disconnect", `Lost connection to Vantage. ${msg}`);
    }
  } finally {
    clearIdle();
    // Release the underlying ReadableStream regardless of how we exited.
    if (reader) reader.cancel().catch(() => {});
  }
}

// ─── Inline-HITL submit (P1-C) ────────────────────────────────────────
//
// Companion to runAskStream — POSTs the user's HITL decision to
// /api/ask/resume and streams the continuation back via the same
// callback contract. The dock invokes this when the user clicks
// Approve / picks a chip / submits a free-form HITL answer.
export interface SubmitAskResumeArgs {
  resumeToken: string;
  value: string | string[] | Record<string, unknown>;
  abortController: AbortController;
  callbacks: AskStreamCallbacks;
}

export async function submitAskResume({
  resumeToken,
  value,
  abortController,
  callbacks,
}: SubmitAskResumeArgs): Promise<void> {
  const cb = callbacks;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/ask/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ resume_token: resumeToken, value }),
      signal: abortController.signal,
    });
    if (!res.ok || !res.body) {
      const payload = await res
        .json()
        .catch(() => null as unknown as AskErrorPayload | null);
      const hint =
        payload && typeof payload === "object" && "hint" in payload
          ? (payload as AskErrorPayload).hint
          : undefined;
      cb.onError(
        res.status === 403 ? "forbidden" : "frame",
        hint ?? `/api/ask/resume returned ${res.status}`,
      );
      return;
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        let frame: StreamFrame | null = null;
        try {
          frame = JSON.parse(line) as StreamFrame;
        } catch {
          frame = null;
        }
        if (!frame) continue;
        // Reuse the same per-kind callbacks; we just inline a minimal
        // dispatch to avoid duplicating handleFrame.
        switch (frame.kind) {
          case "text":
            cb.onAssistantDelta(frame.delta);
            break;
          case "agent_start":
            cb.onAgentStart(frame.agent, frame.label);
            break;
          case "agent_done":
            cb.onAgentDone(frame.agent, frame.statusText);
            break;
          case "agent_failed":
            cb.onAgentFailed(frame.agent, frame.statusText);
            break;
          case "artifact":
            if (cb.onArtifact) cb.onArtifact(frame.artifact);
            break;
          case "ask_user":
            if (cb.onAskUser) cb.onAskUser(frame);
            break;
          case "diff":
            if (cb.onDiff) cb.onDiff(frame);
            break;
          case "approval":
            if (cb.onApproval) cb.onApproval(frame);
            break;
          case "done":
            cb.onDone();
            return;
          case "error":
            cb.onError("frame", frame.message, {
              ...(frame.code !== undefined ? { code: frame.code } : {}),
              ...(frame.trace_id !== undefined ? { trace_id: frame.trace_id } : {}),
            });
            return;
        }
      }
    }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    if (!aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      cb.onError("disconnect", `Lost connection during HITL resume. ${msg}`);
    }
  } finally {
    if (reader) reader.cancel().catch(() => {});
  }
}

// ─── Dock wrapper ──────────────────────────────────────────────────────

export async function sendAsk(
  prompt: string,
  attachments: DockAttachment[] = [],
  opts: SendAskOptions = {},
): Promise<void> {
  const dock = useDock.getState();
  const threadId = opts.threadIdOverride ?? dock.threadId;
  if (!prompt.trim() || !threadId) return;

  // Cancel any in-flight stream first so a new question replaces the old.
  dock.cancelStream();

  const footer = formatAttachmentsFooter(attachments);
  const wirePrompt = `${prompt}${footer}`;
  // Clear composer-attached files now that they're committed to a message.
  if (attachments.length > 0) dock.clearAttachments();

  const userMsgId = dock.pushMessage({ kind: "user", text: wirePrompt });
  const assistantMsgId = dock.pushMessage({ kind: "assistant", text: "" });
  const agentGroupMsgId = dock.pushMessage({ kind: "agents", agents: [] });

  // Optimistic rail: surface the new prompt in RECENT immediately. The
  // id here is the in-memory bubble id, which doubles as a scroll target
  // when the user later clicks the anchor — see RecentRail in dock.tsx.
  // Reconciliation with the persisted conversation_messages.id happens
  // on the next dock mount via GET /api/ask/recent.
  if (!opts.surface || opts.surface === "dock") {
    useDock.getState().prependRecentAnchor({
      id: userMsgId,
      preview: wirePrompt,
      createdAt: new Date().toISOString(),
    });
  }

  const controller = new AbortController();
  useDock.setState({ abortController: controller, streaming: true, input: "" });

  let assistantBuf = "";
  const groupAgentIds: string[] = [];
  // null until the coordinator emits its plan; once set, downstream
  // agent_start/done frames also mutate the corresponding step row.
  let taskGraphMsgId: string | null = null;
  // Look up requires_review for the current step so onAgentDone can pick
  // "review" instead of "done" when the step is HITL-gated. Keyed by
  // agent string — same key the planner used.
  const stepReviewMap = new Map<string, boolean>();

  // Guard against late writes from a stream that was superseded by a
  // newer send: if our assistant bubble no longer exists (a new turn
  // reset/replaced messages, or this stream was abandoned), drop the
  // mutation instead of resurrecting a stale message id.
  const ourBubbleAlive = () =>
    useDock.getState().messages.some((m) => m.id === assistantMsgId);

  // Only clear streaming/abortController if *this* invocation still owns
  // the live controller. A newer send (which calls cancelStream then
  // installs its own controller) must not have its state wiped by the
  // abandoned old stream's terminal/finally path.
  //
  // P2 (round-3): the original guard handled the abandonment case
  // (newer stream has installed its own controller) but missed the
  // *orphan* case — when this stream was the most recent one but its
  // controller was already cleared by cancelStream() (user cancel,
  // unmount cleanup). In that orphan case `abortController === null`,
  // the equality check fails, and `streaming` stays true forever.
  // Treating both "we still own it" and "no one owns it" as safe-to-clear
  // closes the rapid-fire race the round-3 SSE audit flagged.
  const clearOwnedStreamState = () => {
    const current = useDock.getState().abortController;
    if (current === controller || current === null) {
      useDock.setState({ streaming: false, abortController: null });
    }
  };

  const updateAssistant = (delta: string) => {
    if (!ourBubbleAlive()) return;
    assistantBuf += delta;
    useDock.setState((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantMsgId ? { ...m, text: assistantBuf } : m,
      ),
    }));
  };

  await runAskStream({
    prompt: wirePrompt,
    threadId,
    surface: opts.surface,
    abortController: controller,
    callbacks: {
      onAssistantDelta: updateAssistant,
      onReasoning: (text) => {
        // Provider chain-of-thought delta — append to the most recent
        // running agent event so the dock's ReasoningSummary can paint
        // the live transcript inside its expandable Thinking body.
        // Dropped on the floor if no agent is currently running (the
        // store mutator handles that case so we don't have to here).
        if (!ourBubbleAlive()) return;
        dock.appendReasoning(text);
      },
      onNarrator: (text) => {
        // Each narrator chip lives as its own message so it interleaves
        // naturally with task_graph / agents / artifact in the dock log.
        // We don't try to fold consecutive narrators into one bubble —
        // each one corresponds to a discrete tool invocation, and seeing
        // the rhythm of "narrate → spinner → result → narrate → ..." is
        // the whole point of Step 1.
        if (!text || !text.trim()) return;
        dock.pushMessage({ kind: "narrator", text: text.trim() });
      },
      onPartialArtifact: (frame) => {
        // Step 5 — live snapshot. The dock store merges by artifact_id;
        // multiple deltas for the same artifact mutate the same row so
        // the user sees the bullet list / cover paragraph filling in.
        if (!frame.artifact_id) return;
        dock.upsertPartialArtifact({
          artifactId: frame.artifact_id,
          artifactKind: frame.artifact_kind,
          title: frame.title,
          sub: frame.sub,
          progress: frame.progress,
          payload: frame.payload,
        });
      },
      onToolTrace: (frame) => {
        // Step 3 — append a console row. The dock renders these
        // collapsed by default; click to expand. We don't try to merge
        // back into the agent row because the user mental model is
        // "trace = what the LLM did", "agent row = which subsystem ran" —
        // those are two different lenses on the same execution.
        dock.pushMessage({
          kind: "tool_trace",
          toolName: frame.tool,
          toolAgent: frame.agent,
          toolAction: frame.action,
          toolStatus: frame.status,
          toolSummary: frame.summary,
          toolStartedAt: Date.now(),
          // Inline-detail upgrade: surface raw input + (capped) output
          // so the dock's ToolTraceRow can render expandable
          // Input / Output JSON blocks. Both undefined → falls back to
          // the prior metadata-only expand panel.
          toolArgs: frame.args,
          toolResult: frame.result,
        });
      },
      onTaskGraph: (graph) => {
        // Plan arrives once per turn, before any agent_start. Render it
        // above the agent group so users see the *intent* of the run
        // first — this is the "可解释任务图" the audit asked for.
        const steps = graph.plan.map((p) => ({
          step: p.step,
          agent: p.agent,
          label: p.label,
          requires_review: p.requires_review,
          status: "pending" as const,
        }));
        // Step 4: index by step id AND agent so onAgentDone can resolve the
        // review flag either way (dock_agent path has the id; legacy path
        // still falls back to agent name).
        steps.forEach((s) => {
          stepReviewMap.set(s.agent, !!s.requires_review);
          stepReviewMap.set(s.step, !!s.requires_review);
        });
        taskGraphMsgId = dock.pushMessage({
          kind: "task_graph",
          taskId: graph.task_id,
          userGoal: graph.user_goal,
          steps,
        });
      },
      onAgentStart: (agent, label, planStep) => {
        const id = `ev-${agent}-${Date.now()}-${groupAgentIds.length}`;
        const ev: AgentEvent = {
          id,
          agent,
          label: label || `${AGENT_LABELS[agent] ?? agent.toUpperCase()} · running`,
          state: "running",
          statusText: "running",
          ts: Date.now(),
        };
        dock.updateAgentEvent(ev);
        groupAgentIds.push(id);
        // Step 4: prefer deterministic step-id when present (dock_agent
        // path); fall back to agent-name matching for legacy router path.
        if (taskGraphMsgId) {
          if (planStep) {
            dock.updateTaskGraphStepById(taskGraphMsgId, planStep, "running");
          } else {
            dock.updateTaskGraphStep(taskGraphMsgId, agent, "running");
          }
        }
        useDock.setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === agentGroupMsgId ? { ...m, agents: [...groupAgentIds] } : m,
          ),
        }));
      },
      onAgentDone: (agent, statusText, planStep) => {
        const events = useDock.getState().agentEvents;
        const target = groupAgentIds
          .map((id) => events[id])
          .filter(Boolean)
          .reverse()
          .find((e) => e.agent === agent && e.state === "running");
        if (target) dock.updateAgentEvent({ ...target, state: "done", statusText });
        if (taskGraphMsgId) {
          // HITL steps go to "review" — the user still has to approve.
          // Non-HITL steps go straight to "done". When we know the
          // planStep we look the review flag up by id; the legacy fallback
          // still uses the agent map.
          if (planStep) {
            const next = stepReviewMap.has(planStep)
              ? stepReviewMap.get(planStep)
                ? "review"
                : "done"
              : stepReviewMap.get(agent)
                ? "review"
                : "done";
            dock.updateTaskGraphStepById(taskGraphMsgId, planStep, next);
          } else {
            const next = stepReviewMap.get(agent) ? "review" : "done";
            dock.updateTaskGraphStep(taskGraphMsgId, agent, next);
          }
        }
      },
      onAgentFailed: (agent, statusText, planStep) => {
        const events = useDock.getState().agentEvents;
        const target = groupAgentIds
          .map((id) => events[id])
          .filter(Boolean)
          .reverse()
          .find((e) => e.agent === agent && e.state === "running");
        if (target) dock.updateAgentEvent({ ...target, state: "failed", statusText });
        if (taskGraphMsgId) {
          if (planStep) {
            dock.updateTaskGraphStepById(taskGraphMsgId, planStep, "failed");
          } else {
            dock.updateTaskGraphStep(taskGraphMsgId, agent, "failed");
          }
        }
      },
      onResult: ({ title, sub, action, route }) => {
        dock.pushMessage({
          kind: "result",
          title,
          sub,
          action,
          onAction: route
            ? () => {
                if (typeof window !== "undefined") window.location.assign(route);
              }
            : undefined,
        });
      },
      onArtifact: (a) => {
        // Map ask-stream's Artifact (snake_case wire format) to the
        // store's ArtifactPayload (camelCase, matches the rest of zustand
        // conventions). Storing it on the message lets every later
        // render derive button state, evidence list and confidence pill
        // from one source of truth.
        dock.pushMessage({
          kind: "artifact",
          artifact: {
            artifactType: a.artifact_type,
            artifactId: a.id,
            artifactTitle: a.title,
            artifactSub: a.sub,
            confidence: a.confidence,
            needsUserReview: a.needs_user_review,
            sourceEvidence: a.source_evidence?.map((e) => ({
              label: e.label,
              route: e.route,
            })),
            nextActions: a.next_actions?.map((n) => ({
              kind: n.kind,
              label: n.label,
              route: n.route,
            })),
            suggestions: a.suggestions?.map((s) => ({
              id: s.id,
              bulletStableId: s.bullet_stable_id,
              section: s.section,
              changeType: s.change_type,
              beforeText: s.before_text,
              afterText: s.after_text,
              rationale: s.rationale,
              riskLevel: s.risk_level,
            })),
            sourceResumeId: a.source_resume_id,
          },
        });
      },
      onAskUser: (frame) => {
        // Inline HITL: render a chip/free-form bubble. The user's selection
        // calls submitAskResume which streams the continuation back through
        // the SAME callback set, so subsequent text / artifact / done frames
        // land in this same assistant turn.
        dock.pushMessage({
          kind: "hitl_ask_user",
          hitlStatus: "pending",
          resumeToken: frame.resume_token,
          hitlAskUser: {
            question: frame.question,
            chips: frame.chips,
            freeForm: frame.free_form !== false,
          },
        });
      },
      onDiff: (frame) => {
        dock.pushMessage({
          kind: "hitl_diff",
          hitlStatus: "pending",
          resumeToken: frame.resume_token,
          hitlDiff: {
            before: frame.before,
            after: frame.after,
          },
        });
      },
      onApproval: (frame) => {
        dock.pushMessage({
          kind: "hitl_approval",
          hitlStatus: "pending",
          resumeToken: frame.resume_token,
          hitlApproval: {
            action: frame.action,
            payload: frame.payload,
          },
        });
      },
      onDone: () => {
        clearOwnedStreamState();
      },
      onError: (kind, message, meta) => {
        // SSE4 (round-9): map every error kind to a copy that tells the
        // user whether retrying is worth it. trace_id (when present) is
        // appended so support can correlate without quizzing the user.
        const traceLine = meta?.trace_id
          ? `\n_Reference: ${meta.trace_id}_`
          : "";
        if (kind === "budget") {
          // The Python global handler renders a sanitized "session
          // budget used up" string; show it verbatim because it is
          // already user-safe (no debug paths or cent math leak through
          // — see agents/api/server.py:_error_envelope).
          updateAssistant(`\n\n_${message}_${traceLine}`);
        } else if (kind === "forbidden") {
          updateAssistant(
            `\n\n_${message} You may need to sign in again._${traceLine}`,
          );
        } else if (kind === "frame") {
          updateAssistant(
            `\n\n_Something went wrong: ${message}_${traceLine}`,
          );
        } else if (kind === "timeout") {
          // DOCK_R3 (round-19): the round-19 audit found that partial
          // SSE responses froze in place without any sign they were
          // incomplete — the user read what was there as if it were
          // the full answer. When `assistantBuf` already has tokens
          // we lead the error suffix with "[answer interrupted]" so
          // the truncation is visually unmistakable; the timeout copy
          // still tells them retrying is fine.
          const lead = assistantBuf.length > 0 ? "\n\n_[Answer interrupted]_" : "";
          updateAssistant(`${lead}\n\n_Vantage stream timed out. Try again._`);
        } else if (kind === "unreachable") {
          // Gateway hint is already user-facing copy ("…engine is offline.
          // Try again in a moment — if this persists, check that the
          // agents host is running."). Render it verbatim so the user
          // can distinguish "agent host down" from "network blip".
          const lead = assistantBuf.length > 0 ? "\n\n_[Answer interrupted]_" : "";
          updateAssistant(`${lead}\n\n_${message}_`);
        } else {
          // DOCK_R3 (round-19): same "interrupted" lead for `disconnect`
          // — the most common path when the agent host restarts mid-stream.
          const lead = assistantBuf.length > 0 ? "\n\n_[Answer interrupted]_" : "";
          updateAssistant(`${lead}\n\n_Lost connection to Vantage. Try again._`);
        }
        clearOwnedStreamState();
      },
    },
  });
}

// ─── Dock-level HITL responder ────────────────────────────────────────
//
// One-call helper the dock-hitl-card component invokes when the user
// clicks Approve / picks a chip / submits free-form text. Drives the
// store transition (pending → submitting → answered) and streams the
// LangGraph continuation back into the live assistant turn via the
// existing dock store. The dock UI doesn't need to know about
// AbortController or callbacks — this is the only function it imports.
export async function respondToHitl(
  messageId: string,
  resumeToken: string,
  value: string | string[] | Record<string, unknown>,
  answerSummary?: string,
): Promise<void> {
  const dock = useDock.getState();
  dock.setHitlStatus(messageId, "submitting", answerSummary);

  // Re-use the dock-owned controller so a Cancel cancels the whole
  // resumed stream, not just the original turn.
  const controller = dock.abortController ?? new AbortController();
  useDock.setState({
    abortController: controller,
    streaming: true,
  });

  // Bubble for the new assistant turn that lands AFTER the HITL.
  const assistantMsgId = dock.pushMessage({ kind: "assistant", text: "" });
  let assistantBuf = "";

  await submitAskResume({
    resumeToken,
    value,
    abortController: controller,
    callbacks: {
      onAssistantDelta: (delta) => {
        assistantBuf += delta;
        useDock.setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, text: assistantBuf } : m,
          ),
        }));
      },
      onAgentStart: () => {},
      onAgentDone: () => {},
      onAgentFailed: () => {},
      onResult: ({ title, sub, action }) => {
        dock.pushMessage({ kind: "result", title, sub, action });
      },
      onArtifact: (a) => {
        dock.pushMessage({
          kind: "artifact",
          artifact: {
            artifactType: a.artifact_type,
            artifactId: a.id,
            artifactTitle: a.title,
            artifactSub: a.sub,
            confidence: a.confidence,
            needsUserReview: a.needs_user_review,
            sourceEvidence: a.source_evidence?.map((e) => ({
              label: e.label,
              route: e.route,
            })),
            nextActions: a.next_actions?.map((n) => ({
              kind: n.kind,
              label: n.label,
              route: n.route,
            })),
            suggestions: a.suggestions?.map((s) => ({
              id: s.id,
              bulletStableId: s.bullet_stable_id,
              section: s.section,
              changeType: s.change_type,
              beforeText: s.before_text,
              afterText: s.after_text,
              rationale: s.rationale,
              riskLevel: s.risk_level,
            })),
            sourceResumeId: a.source_resume_id,
          },
        });
      },
      onAskUser: (frame) => {
        // The continuation may surface ANOTHER HITL (e.g. tailor → diff
        // → approval). Render it the same way the main stream does.
        dock.pushMessage({
          kind: "hitl_ask_user",
          hitlStatus: "pending",
          resumeToken: frame.resume_token,
          hitlAskUser: {
            question: frame.question,
            chips: frame.chips,
            freeForm: frame.free_form !== false,
          },
        });
      },
      onDiff: (frame) => {
        dock.pushMessage({
          kind: "hitl_diff",
          hitlStatus: "pending",
          resumeToken: frame.resume_token,
          hitlDiff: { before: frame.before, after: frame.after },
        });
      },
      onApproval: (frame) => {
        dock.pushMessage({
          kind: "hitl_approval",
          hitlStatus: "pending",
          resumeToken: frame.resume_token,
          hitlApproval: { action: frame.action, payload: frame.payload },
        });
      },
      onDone: () => {
        dock.setHitlStatus(messageId, "answered");
        useDock.setState({ streaming: false, abortController: null });
      },
      onError: (_kind, message) => {
        dock.setHitlStatus(messageId, "answered");
        useDock.setState({ streaming: false, abortController: null });
        assistantBuf += `\n\n_${message}_`;
        useDock.setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, text: assistantBuf } : m,
          ),
        }));
      },
    },
  });
}

export function cancelHitl(messageId: string): void {
  useDock.getState().setHitlStatus(messageId, "cancelled");
}
