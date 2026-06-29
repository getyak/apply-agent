// Ask Vantage gateway — TS pass-through between the web dock and the Python
// LangGraph host (agents/api/server.py /ask/stream).
//
// PR2 (AG-UI cutover): this gateway no longer translates the stream. The
// agents layer emits native AG-UI SSE frames (RUN_STARTED … RUN_FINISHED plus
// Relay `relay.*` CUSTOM events); the web `@ag-ui/client` consumer is the only
// place that interprets them. The gateway's job is back to network plumbing:
//   - auth (JWT → X-Relay-User-Id)
//   - trace / request id injection (one trace, three layers)
//   - locale resolution + X-Relay-Locale forwarding
//   - byte pass-through of the upstream SSE body
//
// HITL resume no longer has its own endpoint: the client posts a NEW
// /api/ask/stream turn with a `command: {resume: ...}` field, which we forward
// in the body untouched.

import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config";
import { query } from "../db";
import { coerceLocale, localeFromHeader } from "../locale";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const routes = new Hono<AppEnv>();

// Strip a stored anchor to ~80 chars without slicing a multi-byte char in
// half. Used for the /recent rail preview. The DB keeps the full text — we
// only truncate at read time.
function previewText(s: string, max = 80): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  let out = "";
  for (const ch of trimmed) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return out + "…";
}

// ─── POST /api/ask/stream — pure pass-through ─────────────────────────────
//
// Forwards the raw request body to the agents host and streams the upstream
// SSE body back byte-for-byte. The body schema is owned by the agents host;
// the gateway does not parse or translate it.

routes.use("/stream", authMiddleware);
routes.post("/stream", async (c) => {
  const userId = c.get("userId") as string;
  // Resolve the locale once. Precedence: X-Relay-Locale header → Accept-Language
  // → "en". Forwarded downstream so the agent reply language is pinned. (The
  // dock sets X-Relay-Locale from its NEXT_LOCALE cookie mirror.)
  const resolvedLocale =
    coerceLocale(c.req.header("x-relay-locale")) ??
    localeFromHeader(c.req.header("accept-language"));
  // Thread id + surface ride as headers (the agents host reads them); the dock
  // sends them today. We don't parse the JSON body — pass it through raw.
  const threadId = c.req.header("x-relay-thread-id") ?? undefined;
  const surface = c.req.header("x-relay-surface") ?? undefined;
  const requestId = c.get("requestId");
  const traceId = c.get("traceId");

  // Raw body pass-through: read once as text and forward verbatim. The agents
  // host validates the JSON (message / command / etc.).
  const rawBody = await c.req.text();

  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/ask/stream`;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Trust boundary: the gateway verified the JWT in authMiddleware. We
        // pass user_id as a header that agents/api/server.py reads as its
        // UserDep so the FastAPI side doesn't re-verify.
        "X-Relay-User-Id": userId,
        ...(threadId ? { "X-Relay-Thread-Id": threadId } : {}),
        ...(surface ? { "X-Relay-Surface": surface } : {}),
        "X-Relay-Locale": resolvedLocale,
        ...(requestId ? { "X-Request-Id": requestId } : {}),
        ...(traceId ? { "X-Trace-Id": traceId } : {}),
      },
      body: rawBody,
    });
  } catch (err) {
    // Most common cause in dev/CI: the Python LangGraph host isn't running.
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
    console.warn("[ask] upstream not ok:", {
      target,
      status: upstream.status,
      hasBody: !!upstream.body,
      detail: detail.slice(0, 200),
    });
    return c.json(
      {
        error: "agent_failed",
        code: "AGENT_FAILED",
        hint: "Vantage's reasoning engine returned an error. We're looking into it.",
        status: upstream.status,
        detail,
      },
      upstream.status === 403 ? 403 : 502,
    );
  }

  // Pure pass-through: hand the upstream SSE body straight back, preserving the
  // trace id for support correlation. No parsing, no translation.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Trace-Id": upstream.headers.get("X-Trace-Id") ?? traceId ?? "",
    },
  });
});

// ─── GET /api/ask/recent — RECENT rail ────────────────────────────────────
//
// Lists the user's most recent prompts from the lifetime ask_vantage thread,
// newest first (vantage-ui-mapping.md §1.2 anchors-only model). We only return
// user rows; `limit` is capped server-side so a crafted client can't pull the
// entire history.
routes.use("/recent", authMiddleware);
routes.get("/recent", async (c) => {
  const userId = c.get("userId") as string;
  const limitRaw = c.req.query("limit");
  const limit = Math.max(
    1,
    Math.min(50, limitRaw ? Number.parseInt(limitRaw, 10) || 10 : 10),
  );

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

// Surfaces the dock may set on X-Relay-Surface (documented for reference; the
// gateway forwards the header verbatim and does not enforce the enum).
export const ASK_SURFACES = ["dock", "resume_studio", "mock_studio", "applications"] as const;

// Re-exported for any caller that still wants to validate a stream body shape
// (the gateway itself no longer parses it — the agents host owns the contract).
export const AskBody = z.object({
  message: z.string().max(8_000).optional(),
  command: z.record(z.string(), z.unknown()).optional(),
});

export default routes;
