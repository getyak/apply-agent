// Ask Vantage SSE client.
//
// Connects to POST /api/ask/stream and translates LangGraph
// astream_events frames into UI mutations on the dock store.
// We can't use the native EventSource because it's GET-only and
// can't send the bearer token; we do fetch + ReadableStream so we
// can send Authorization headers and abort cleanly.
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

  const onAgentStart = (agent: string, label: string) => {
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
  };

  const finishAgent = (
    agent: string,
    state: "done" | "failed",
    statusText: string,
  ) => {
    const events = useDock.getState().agentEvents;
    const target = groupAgentIds
      .map((id) => events[id])
      .filter(Boolean)
      .reverse()
      .find((e) => e.agent === agent && e.state === "running");
    if (!target) return;
    dock.updateAgentEvent({ ...target, state, statusText });
  };

  // Dispatch a single decoded NDJSON frame. Returns "stop" when the
  // stream should terminate (done/error), otherwise "continue". Shared
  // by the read loop and the trailing-frame flush below.
  const handleFrame = (frame: StreamFrame): "continue" | "stop" => {
    switch (frame.kind) {
      case "text":
        updateAssistant(frame.delta);
        return "continue";
      case "agent_start":
        onAgentStart(frame.agent, frame.label);
        return "continue";
      case "agent_done":
        finishAgent(frame.agent, "done", frame.statusText);
        return "continue";
      case "agent_failed":
        finishAgent(frame.agent, "failed", frame.statusText);
        return "continue";
      case "result":
        dock.pushMessage({
          kind: "result",
          title: frame.title,
          sub: frame.sub,
          action: frame.action,
          onAction:
            frame.route && isSafeRoute(frame.route)
              ? () => {
                  if (typeof window !== "undefined" && frame.route)
                    window.location.assign(frame.route);
                }
              : undefined,
        });
        return "continue";
      case "done":
        clearOwnedStreamState();
        return "stop";
      case "error":
        updateAssistant(`\n\n_Something went wrong: ${frame.message}_`);
        clearOwnedStreamState();
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
      controller.abort();
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
        prompt: wirePrompt,
        thread_id: threadId,
        ...(opts.surface ? { surface: opts.surface } : {}),
      }),
      signal: controller.signal,
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
      updateAssistant("\n\n_Vantage stream timed out. Try again._");
    } else if (!aborted) {
      updateAssistant("\n\n_Lost connection to Vantage. Try again._");
    }
  } finally {
    clearIdle();
    // Release the underlying ReadableStream regardless of how we exited.
    if (reader) reader.cancel().catch(() => {});
    clearOwnedStreamState();
  }
}
