// Ask Vantage proxy — TS gateway between the web dock and the Python
// LangGraph host (agents/api/server.py /ask/stream).
//
// Translation contract:
//   FastAPI side sends classic SSE: "data: {event, …}\n\n" frames with
//   event ∈ { thinking, intent, result, error, done }.
//   The web dock (web/src/lib/ask-stream.ts) consumes line-delimited
//   JSON (application/x-ndjson) with kind ∈ { text, agent_start,
//   agent_done, agent_failed, result, done, error }.
//
// We do the protocol bridge here so neither side has to change. The
// dock sees one consistent shape regardless of how many agent layers
// sit behind it. The FastAPI side is free to evolve its event names
// without breaking the web client.

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { config } from "../config";
import { authMiddleware } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import type { AppEnv } from "../types";

const AskBody = z.object({
  prompt: z.string().min(1).max(8_000),
  thread_id: z.string().min(1).max(200),
});

const AGENT_HUMAN_LABEL: Record<string, string> = {
  resume_agent: "RÉSUMÉ AGENT",
  jobmatch_agent: "SCOUT AGENT",
  interview_agent: "INTERVIEW AGENT",
  appprep_agent: "APPLICATION AGENT",
  trend_agent: "TREND AGENT",
  coordinator: "COORDINATOR",
};

const routes = new Hono<AppEnv>();

routes.use("/stream", authMiddleware);
routes.post("/stream", validateBody(AskBody), async (c) => {
  const { prompt, thread_id } = c.get("validatedBody") as z.infer<
    typeof AskBody
  >;
  const userId = c.get("userId") as string;
  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/ask/stream`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Trust boundary: the gateway already verified the JWT in
        // requireAuth. We pass user_id through as a header that
        // agents/api/server.py reads as its UserDep so the FastAPI
        // side doesn't re-verify (and doesn't need the JWT secret).
        "X-Relay-User-Id": userId,
        "X-Relay-Thread-Id": thread_id,
      },
      body: JSON.stringify({ message: prompt }),
    });
  } catch (err) {
    // Most common cause in dev/CI: the Python LangGraph host isn't
    // running. The dock catches `code` and renders the `hint` verbatim
    // instead of "Upstream error", so the user knows it's a setup
    // issue, not a product bug.
    return c.json(
      {
        error: "agent_unreachable",
        code: "AGENT_UNREACHABLE",
        hint: "Vantage's reasoning engine is offline. Try again in a moment — if this persists, check that the agents host is running.",
        detail: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.warn(
      "[ask] upstream not ok:",
      { target, status: upstream.status, hasBody: !!upstream.body, detail: detail.slice(0, 200) },
    );
    return c.json(
      {
        error: "agent_failed",
        code: "AGENT_FAILED",
        hint: "Vantage's reasoning engine returned an error. We're looking into it.",
        status: upstream.status,
        detail,
      },
      502,
    );
  }

  return stream(c, async (out) => {
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const seenAgents = new Set<string>();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines ("\n\n").
        let split = buf.indexOf("\n\n");
        while (split >= 0) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          split = buf.indexOf("\n\n");
          const payload = parseSseFrame(frame);
          if (!payload) continue;
          for (const line of toNdjson(payload, seenAgents)) {
            await out.write(line + "\n");
          }
        }
      }
    } catch (err) {
      await out.write(
        JSON.stringify({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    } finally {
      try {
        reader.cancel();
      } catch {
        // Already cancelled if the upstream finished.
      }
    }
  });
});

function parseSseFrame(frame: string): Record<string, unknown> | null {
  // Each SSE frame is a sequence of `field: value` lines; we only care
  // about `data:`. Multiple `data:` lines concatenate with newlines.
  const lines = frame.split("\n");
  const data = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Map the FastAPI event vocabulary onto the dock's NDJSON contract.
// Returns 0..N lines per upstream frame.
function toNdjson(
  payload: Record<string, unknown>,
  seenAgents: Set<string>,
): string[] {
  const event = payload.event as string | undefined;
  if (!event) return [];

  if (event === "thinking") {
    const agent = (payload.agent as string) || "coordinator";
    if (seenAgents.has(agent)) return [];
    seenAgents.add(agent);
    return [
      JSON.stringify({
        kind: "agent_start",
        agent,
        label: `${AGENT_HUMAN_LABEL[agent] ?? agent.toUpperCase()} · thinking`,
      }),
    ];
  }

  if (event === "intent") {
    const intent = (payload.intent as string) || "";
    const text = `Routing to ${intent.replace(/_/g, " ")} (via ${payload.via}).`;
    return [JSON.stringify({ kind: "text", delta: text + "\n\n" })];
  }

  if (event === "result") {
    const agent = (payload.agent as string) || "coordinator";
    const out: string[] = [];
    if (seenAgents.has(agent)) {
      out.push(
        JSON.stringify({
          kind: "agent_done",
          agent,
          statusText: "done",
        }),
      );
    }
    // Smalltalk replies arrive as { agent: 'coordinator', action: 'reply', text }
    if (typeof payload.text === "string" && payload.text) {
      out.push(JSON.stringify({ kind: "text", delta: payload.text }));
    }
    const action = payload.action as string | undefined;
    if (action && action !== "reply") {
      const route = routeFor(agent, action);
      out.push(
        JSON.stringify({
          kind: "result",
          title: humanizeAction(agent, action),
          sub: describeAction(payload),
          action: ctaFor(agent, action),
          ...(route ? { route } : {}),
        }),
      );
    }
    return out;
  }

  if (event === "error") {
    return [
      JSON.stringify({
        kind: "error",
        message: (payload.message as string) || "Upstream error",
      }),
    ];
  }

  if (event === "done") {
    return [JSON.stringify({ kind: "done" })];
  }

  return [];
}

function humanizeAction(agent: string, action: string): string {
  if (agent === "resume_agent" && action === "customize") return "Tailored résumé ready";
  if (agent === "resume_agent" && action === "update_field") return "Résumé update queued";
  if (agent === "interview_agent" && action === "build_mock_graph") return "Mock session ready";
  if (agent === "trend_agent" && action === "daily_snapshot") return "Today's market snapshot";
  if (agent === "jobmatch_agent" && action === "find_matches") return "Matching roles found";
  if (agent === "appprep_agent" && action === "draft_cover_letter") return "Cover letter drafted";
  return `${agent.replace(/_/g, " ")} → ${action}`;
}

function describeAction(payload: Record<string, unknown>): string {
  const status = payload.status as string | undefined;
  if (status === "not_implemented_yet") return "Coming soon — wired up but not generating yet.";
  if (status === "needs_clarification") return "Tell me which field to update.";
  return "Open it to keep going.";
}

function ctaFor(agent: string, action: string): string {
  if (agent === "resume_agent") return "Open résumé";
  if (agent === "interview_agent") return "Open mock";
  if (agent === "trend_agent") return "View trends";
  if (agent === "jobmatch_agent") return "See matches";
  if (agent === "appprep_agent") return "Open prep";
  void action;
  return "Open";
}

function routeFor(agent: string, action: string): string | null {
  if (agent === "resume_agent") return "/app/studio/resume";
  if (agent === "interview_agent" && action === "build_mock_graph")
    return "/app/studio/mock";
  if (agent === "trend_agent") return "/app/today";
  if (agent === "jobmatch_agent") return "/app/applications";
  if (agent === "appprep_agent") return "/app/applications";
  return null;
}

export default routes;
