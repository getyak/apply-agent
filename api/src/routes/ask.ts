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
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import type { AppEnv } from "../types";

// Surfaces map 1:1 to the document-scoped conversation channels described
// in vantage-ui-mapping.md §2.6. The dock is the cross-surface lifetime
// thread; resume_studio is the per-résumé vibe chat. Anything else falls
// through to the dock channel server-side.
const SURFACES = ["dock", "resume_studio", "mock_studio", "applications"] as const;

const AskBody = z.object({
  prompt: z.string().min(1).max(8_000),
  thread_id: z.string().min(1).max(200),
  surface: z.enum(SURFACES).optional(),
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

// Lifetime ask_vantage session id resolver. Per docs/architecture/
// vantage-ui-mapping.md §1.2, every user has exactly one ask_vantage
// session — enforced by idx_sessions_ask_vantage_per_user (migration
// 012). We INSERT with ON CONFLICT DO NOTHING and follow up with a SELECT
// so the resolver works whether or not the session already exists. The
// thread_id the dock keeps in localStorage (`ask_vantage:{userId}`)
// drives LangGraph's checkpointer; the conversation_sessions row drives
// our own history rail (the dock's RECENT list).
async function ensureAskVantageSession(userId: string): Promise<string> {
  const insert = await query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (user_id, session_type, agent_type, title, status)
     VALUES ($1, 'ask_vantage', 'coordinator', 'Ask Vantage', 'active')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId],
  );
  if (insert.rows.length > 0) return insert.rows[0].id;
  // Conflict path: row already existed — fetch it.
  const sel = await query<{ id: string }>(
    `SELECT id FROM conversation_sessions
      WHERE user_id = $1 AND session_type = 'ask_vantage'
      LIMIT 1`,
    [userId],
  );
  if (sel.rows.length === 0) {
    // Should be unreachable: the unique partial index guarantees the
    // INSERT only conflicts when the row exists. Defensive throw so we
    // surface schema drift rather than silently dropping history.
    throw new Error("ensureAskVantageSession: row vanished after conflict");
  }
  return sel.rows[0].id;
}

// Strip a stored anchor to ~80 chars without slicing a multi-byte char in
// half. Used for both the user-prompt preview and the assistant content
// rail. The DB still has the full text — we only truncate at read time.
function previewText(s: string, max = 80): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  // Iterate codepoint-by-codepoint via the iterator so we don't cut a
  // surrogate pair (emoji, some CJK runs).
  let out = "";
  for (const ch of trimmed) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return out + "…";
}

routes.use("/stream", authMiddleware);
routes.post("/stream", validateBody(AskBody), async (c) => {
  const { prompt, thread_id, surface } = c.get("validatedBody") as z.infer<
    typeof AskBody
  >;
  const userId = c.get("userId") as string;
  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/ask/stream`;

  // History persistence — kept best-effort. If the conversation_messages
  // INSERTs fail we still want the dock to get its stream; the chat
  // remains usable, we just lose the RECENT anchor for that turn. Log so
  // we notice in dev / staging.
  //
  // We only persist for the lifetime ask_vantage thread (the default
  // surface). resume_studio / mock_studio / applications surfaces are
  // per-document scopes that don't share the dock's RECENT rail, so
  // routing their messages here would pollute the rail with content the
  // user can't navigate to from the dock.
  const persistHistory = !surface || surface === "dock";
  let askSessionId: string | null = null;
  let userMessageId: string | null = null;
  if (persistHistory) {
    try {
      askSessionId = await ensureAskVantageSession(userId);
      const ins = await query<{ id: string }>(
        `INSERT INTO conversation_messages
           (session_id, role, content)
         VALUES ($1, 'user', $2)
         RETURNING id`,
        [askSessionId, prompt],
      );
      userMessageId = ins.rows[0].id;
    } catch (err) {
      console.warn("[ask] history persist (user) failed:", err);
      askSessionId = null;
      userMessageId = null;
    }
  }

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
        // surface identifies which UI panel is asking — dock vs the
        // per-document vibe chats (resume_studio etc.). Server-side it
        // changes thread-scoping and lets the router decide what context
        // to load. Default to "dock" upstream if absent, so older clients
        // keep working unchanged.
        ...(surface ? { "X-Relay-Surface": surface } : {}),
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
    // Accumulate everything we emit as { kind: "text" } so we can persist
    // the final assistant turn once the stream settles. Mirrors what the
    // dock concatenates into m.text on the client.
    let assistantBuf = "";

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
            // Peek the frame so we can build a faithful assistant text
            // record for history without re-parsing later. We accumulate
            // before writing — order doesn't matter since both branches
            // run synchronously per frame.
            try {
              const parsed = JSON.parse(line) as { kind?: string; delta?: string };
              if (parsed.kind === "text" && typeof parsed.delta === "string") {
                assistantBuf += parsed.delta;
              }
            } catch {
              /* line is always valid JSON from toNdjson — guard is defensive */
            }
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

      // Persist the assistant half + roll up session counters. Best-effort
      // again — if it fails we already streamed to the user; the only
      // visible degradation is "this turn won't appear in RECENT" which
      // is recoverable on the next message.
      if (askSessionId && assistantBuf.trim().length > 0) {
        try {
          await query(
            `INSERT INTO conversation_messages
               (session_id, role, content, metadata)
             VALUES ($1, 'assistant', $2, $3)`,
            [askSessionId, assistantBuf, JSON.stringify({ agent: "coordinator", surface: surface ?? "dock" })],
          );
          await query(
            `UPDATE conversation_sessions
               SET last_active_at = NOW(),
                   message_count = message_count + 2
             WHERE id = $1`,
            [askSessionId],
          );
        } catch (err) {
          console.warn("[ask] history persist (assistant) failed:", err);
        }
      } else if (askSessionId && userMessageId) {
        // We at least logged the user prompt; still bump message_count
        // for the lone user row so the rail count stays honest. This
        // covers cases where the stream errored before any assistant
        // text accumulated.
        try {
          await query(
            `UPDATE conversation_sessions
               SET last_active_at = NOW(),
                   message_count = message_count + 1
             WHERE id = $1`,
            [askSessionId],
          );
        } catch (err) {
          console.warn("[ask] history persist (count bump) failed:", err);
        }
      }
    }
  });
});

// GET /api/ask/recent — list the user's most recent prompts from the
// lifetime ask_vantage thread, newest first. Used by the dock's RECENT
// rail (vantage-ui-mapping.md §1.2 anchors-only model). We deliberately
// only return user rows; the rail jumps to "where the user last asked
// X", not "where Vantage said Y". `limit` is capped server-side so a
// crafted client can't pull the entire history.
routes.use("/recent", authMiddleware);
routes.get("/recent", async (c) => {
  const userId = c.get("userId") as string;
  const limitRaw = c.req.query("limit");
  const limit = Math.max(
    1,
    Math.min(50, limitRaw ? Number.parseInt(limitRaw, 10) || 10 : 10),
  );

  // Single query joining session → messages; gives us "" rows if the
  // user has no session yet (LEFT JOIN). Cheap because the unique partial
  // index keeps at most one ask_vantage session per user.
  const result = await query<{
    id: string;
    content: string;
    created_at: string;
  }>(
    `SELECT m.id, m.content, m.created_at
       FROM conversation_sessions s
       JOIN conversation_messages m
         ON m.session_id = s.id
      WHERE s.user_id = $1
        AND s.session_type = 'ask_vantage'
        AND m.role = 'user'
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );

  return c.json({
    items: result.rows.map((r) => ({
      id: r.id,
      preview: previewText(r.content),
      createdAt: r.created_at,
    })),
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
