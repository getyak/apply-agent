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
  | "market_snapshot";

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
}

type StreamFrame =
  | { kind: "text"; delta: string }
  | { kind: "task_graph"; graph: TaskGraph }
  | { kind: "agent_start"; agent: string; label: string }
  | { kind: "agent_done"; agent: string; statusText: string }
  | { kind: "agent_failed"; agent: string; statusText: string }
  | {
      kind: "result";
      title: string;
      sub: string;
      action: string;
      route?: string;
    }
  | { kind: "artifact"; artifact: Artifact }
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
  // Coordinator's plan for the current turn. Fires once, before any
  // agent_start. The dock renders it as a task-graph card so users see
  // *what's about to happen* instead of waiting for opaque agent spinners.
  // For backwards compatibility callers may omit this — runAskStream
  // silently swallows task_graph frames when no callback is provided.
  onTaskGraph?: (graph: TaskGraph) => void;
  // Agent task card lifecycle.
  onAgentStart: (agent: string, label: string) => void;
  onAgentDone: (agent: string, statusText: string) => void;
  onAgentFailed: (agent: string, statusText: string) => void;
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
      case "task_graph":
        // Silently drop if the caller didn't opt in. Resume Studio's
        // local-callback flow doesn't show graphs yet; dropping keeps
        // the contract additive.
        if (cb.onTaskGraph) cb.onTaskGraph(frame.graph);
        return "continue";
      case "agent_start":
        cb.onAgentStart(frame.agent, frame.label);
        return "continue";
      case "agent_done":
        cb.onAgentDone(frame.agent, frame.statusText);
        return "continue";
      case "agent_failed":
        cb.onAgentFailed(frame.agent, frame.statusText);
        return "continue";
      case "result":
        cb.onResult({
          title: frame.title,
          sub: frame.sub,
          action: frame.action,
          route: frame.route && isSafeRoute(frame.route) ? frame.route : undefined,
        });
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
        steps.forEach((s) => stepReviewMap.set(s.agent, !!s.requires_review));
        taskGraphMsgId = dock.pushMessage({
          kind: "task_graph",
          taskId: graph.task_id,
          userGoal: graph.user_goal,
          steps,
        });
      },
      onAgentStart: (agent, label) => {
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
        if (taskGraphMsgId) dock.updateTaskGraphStep(taskGraphMsgId, agent, "running");
        useDock.setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === agentGroupMsgId ? { ...m, agents: [...groupAgentIds] } : m,
          ),
        }));
      },
      onAgentDone: (agent, statusText) => {
        const events = useDock.getState().agentEvents;
        const target = groupAgentIds
          .map((id) => events[id])
          .filter(Boolean)
          .reverse()
          .find((e) => e.agent === agent && e.state === "running");
        if (target) dock.updateAgentEvent({ ...target, state: "done", statusText });
        if (taskGraphMsgId) {
          // HITL steps go to "review" — the user still has to approve.
          // Non-HITL steps go straight to "done".
          const next = stepReviewMap.get(agent) ? "review" : "done";
          dock.updateTaskGraphStep(taskGraphMsgId, agent, next);
        }
      },
      onAgentFailed: (agent, statusText) => {
        const events = useDock.getState().agentEvents;
        const target = groupAgentIds
          .map((id) => events[id])
          .filter(Boolean)
          .reverse()
          .find((e) => e.agent === agent && e.state === "running");
        if (target) dock.updateAgentEvent({ ...target, state: "failed", statusText });
        if (taskGraphMsgId) dock.updateTaskGraphStep(taskGraphMsgId, agent, "failed");
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
