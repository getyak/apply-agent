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

type StreamFrame =
  | { kind: "text"; delta: string }
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
  | { kind: "done" }
  | { kind: "error"; message: string };

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
  // Stream terminated normally.
  onDone: () => void;
  // Stream failed mid-flight. `kind` lets the caller distinguish a clean
  // upstream "error" frame from a transport timeout/disconnect so it can
  // surface different copy.
  onError: (kind: "frame" | "timeout" | "disconnect", message: string) => void;
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
      case "done":
        cb.onDone();
        return "stop";
      case "error":
        cb.onError("frame", frame.message);
        return "stop";
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
      throw new Error(`/api/ask/stream returned ${res.status}`);
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

  dock.pushMessage({ kind: "user", text: wirePrompt });
  const assistantMsgId = dock.pushMessage({ kind: "assistant", text: "" });
  const agentGroupMsgId = dock.pushMessage({ kind: "agents", agents: [] });

  const controller = new AbortController();
  useDock.setState({ abortController: controller, streaming: true, input: "" });

  let assistantBuf = "";
  const groupAgentIds: string[] = [];

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
  const clearOwnedStreamState = () => {
    if (useDock.getState().abortController === controller) {
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
        if (!target) return;
        dock.updateAgentEvent({ ...target, state: "done", statusText });
      },
      onAgentFailed: (agent, statusText) => {
        const events = useDock.getState().agentEvents;
        const target = groupAgentIds
          .map((id) => events[id])
          .filter(Boolean)
          .reverse()
          .find((e) => e.agent === agent && e.state === "running");
        if (!target) return;
        dock.updateAgentEvent({ ...target, state: "failed", statusText });
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
      onDone: () => {
        clearOwnedStreamState();
      },
      onError: (kind, message) => {
        if (kind === "frame") {
          updateAssistant(`\n\n_Something went wrong: ${message}_`);
        } else if (kind === "timeout") {
          updateAssistant("\n\n_Vantage stream timed out. Try again._");
        } else {
          updateAssistant("\n\n_Lost connection to Vantage. Try again._");
        }
        clearOwnedStreamState();
      },
    },
  });
}
