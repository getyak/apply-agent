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
import { useDock, type AgentEvent } from "./ask-vantage-store";

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
  // Matches api/src/config.ts API_PORT default (3001). Override with
  // NEXT_PUBLIC_API_BASE in deployment envs.
  const base = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
  return `${base.replace(/\/$/, "")}/api/ask/stream`;
}

export async function sendAsk(prompt: string): Promise<void> {
  const dock = useDock.getState();
  const threadId = dock.threadId;
  if (!prompt.trim() || !threadId) return;

  // Cancel any in-flight stream first so a new question replaces the old.
  dock.cancelStream();

  dock.pushMessage({ kind: "user", text: prompt });
  const assistantMsgId = dock.pushMessage({ kind: "assistant", text: "" });
  const agentGroupMsgId = dock.pushMessage({ kind: "agents", agents: [] });

  const controller = new AbortController();
  useDock.setState({ abortController: controller, streaming: true, input: "" });

  let assistantBuf = "";
  const groupAgentIds: string[] = [];

  const updateAssistant = (delta: string) => {
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

  try {
    const token = getToken();
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ prompt, thread_id: threadId }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`/api/ask/stream returned ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        let frame: StreamFrame;
        try {
          frame = JSON.parse(line) as StreamFrame;
        } catch {
          continue;
        }

        switch (frame.kind) {
          case "text":
            updateAssistant(frame.delta);
            break;
          case "agent_start":
            onAgentStart(frame.agent, frame.label);
            break;
          case "agent_done":
            finishAgent(frame.agent, "done", frame.statusText);
            break;
          case "agent_failed":
            finishAgent(frame.agent, "failed", frame.statusText);
            break;
          case "result":
            dock.pushMessage({
              kind: "result",
              title: frame.title,
              sub: frame.sub,
              action: frame.action,
              onAction: frame.route
                ? () => {
                    if (typeof window !== "undefined" && frame.route)
                      window.location.assign(frame.route);
                  }
                : undefined,
            });
            break;
          case "done":
            useDock.setState({ streaming: false, abortController: null });
            return;
          case "error":
            updateAssistant(`\n\n_Something went wrong: ${frame.message}_`);
            useDock.setState({ streaming: false, abortController: null });
            return;
        }
      }
    }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    if (!aborted) {
      updateAssistant("\n\n_Lost connection to Vantage. Try again._");
    }
  } finally {
    useDock.setState({ streaming: false, abortController: null });
  }
}
