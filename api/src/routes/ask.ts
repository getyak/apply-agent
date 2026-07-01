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
  // Stream resume-by-cursor (D4 of stream-resume-plan): forward the
  // SSE-standard Last-Event-ID header so the agents host can hand back
  // events past the client's cursor. The body field is also honoured
  // downstream; this header path is what an EventSource-based client
  // would use in the future.
  const lastEventId = c.req.header("last-event-id") ?? undefined;

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
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
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
  // ``X-Relay-Resume`` (from the agents host's resume branch) lets the web
  // client tell resume responses apart from fresh turns.
  const responseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Trace-Id": upstream.headers.get("X-Trace-Id") ?? traceId ?? "",
  };
  const resumeMarker = upstream.headers.get("X-Relay-Resume");
  if (resumeMarker) responseHeaders["X-Relay-Resume"] = resumeMarker;
  return new Response(upstream.body, {
    status: 200,
    headers: responseHeaders,
  });
});

// ─── GET /api/ask/history — full thread history for dock hydration ────────
//
// Returns the full message history for the user's lifetime ask_vantage thread
// (or any other session the user owns) so the dock can hydrate its step
// timeline with the prior conversation when it mounts. Without this, every
// reload looked like a fresh window because the dock's step graph only ever
// reflected the *current* turn (vantage-ui-mapping.md §1.2 says ask_vantage
// is a *lifetime* thread — the UI was simply discarding history that was
// already in PG).
//
// Rows are returned in chronological (created_at ASC) order so the dock can
// render top-to-bottom and the live SSE then appends. `limit` is capped to
// 200 so a crafted client can't pull millions of rows; the dock only hydrates
// the recent tail of the lifetime thread.
routes.use("/history", authMiddleware);
routes.get("/history", async (c) => {
  const userId = c.get("userId") as string;
  const threadId = c.req.query("threadId") ?? c.req.query("thread_id");
  const limitRaw = c.req.query("limit");
  const limit = Math.max(
    1,
    Math.min(200, limitRaw ? Number.parseInt(limitRaw, 10) || 50 : 50),
  );

  // The dock derives threadId from auth as `ask_vantage:{userId}`. If the
  // caller omits the query param, fall back to the lifetime thread — most
  // dock mounts will hit this branch.
  const effectiveThreadId = threadId ?? `ask_vantage:${userId}`;

  // Session lookup is scoped by user_id AND thread_id — never trust the
  // client to pick a thread that belongs to someone else (IDOR).
  //
  // Migration 019 introduced a dedicated `thread_id` column; older rows still
  // carry the thread name in `title`. COALESCE(thread_id, title) lets us
  // match both shapes during the rollover window without breaking history.
  const sessionRow = await query<{ id: string }>(
    `SELECT id
       FROM conversation_sessions
      WHERE user_id = $1
        AND COALESCE(thread_id, title) = $2
      LIMIT 1`,
    [userId, effectiveThreadId],
  );

  if (sessionRow.rows.length === 0) {
    return c.json({ threadId: effectiveThreadId, items: [] });
  }

  const sessionId = sessionRow.rows[0].id;

  // Pull the tail newest-first then reverse on the JS side; the SQL stays
  // simple and the dock receives chronological order.
  const result = await query<{
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>(
    `SELECT id, role, content, metadata, created_at
       FROM conversation_messages
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [sessionId, limit],
  );

  const items = result.rows
    .slice()
    .reverse()
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      metadata: r.metadata ?? {},
      createdAt: r.created_at,
    }));

  return c.json({ threadId: effectiveThreadId, items });
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

// ─── /api/ask/sessions — multi-session dock CRUD ──────────────────────────
//
// Migration 019 lifted the one-ask_vantage-per-user constraint so the dock
// (and /app/chat) can hold parallel sessions ("+ New session"). These five
// endpoints power the SessionSwitcher: list / create / rename / delete plus
// a derived label helper. Every endpoint scopes by the authenticated user
// id (IDOR guard) and trusts the column shape from 019.

interface SessionRow {
  id: string;
  thread_id: string | null;
  title: string | null;
  last_preview: string | null;
  message_count: number;
  last_active_at: string;
  created_at: string;
}

interface SessionDto {
  id: string;
  threadId: string;
  label: string;
  preview: string | null;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

function sessionLabel(row: SessionRow): string {
  if (row.title && row.title.trim().length > 0 && row.title !== row.thread_id) {
    return row.title.trim();
  }
  const ts = new Date(row.created_at);
  if (Number.isNaN(ts.getTime())) return "New session";
  return `Conversation · ${ts.toLocaleDateString("en", { month: "short", day: "numeric" })}`;
}

function toSessionDto(row: SessionRow): SessionDto {
  // thread_id is NOT NULL for new sessions (we generate one server-side);
  // for legacy rows that only have `title` we fall back to that value so the
  // dock can still load history through COALESCE(thread_id, title).
  const threadId = row.thread_id ?? row.title ?? "";
  return {
    id: row.id,
    threadId,
    label: sessionLabel(row),
    preview: row.last_preview,
    messageCount: row.message_count,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
  };
}

routes.use("/sessions", authMiddleware);
routes.use("/sessions/*", authMiddleware);

// List all ask_vantage sessions owned by the user, newest activity first.
routes.get("/sessions", async (c) => {
  const userId = c.get("userId") as string;
  const result = await query<SessionRow>(
    `SELECT id, thread_id, title, last_preview, message_count,
            last_active_at, created_at
       FROM conversation_sessions
      WHERE user_id = $1
        AND session_type = 'ask_vantage'
      ORDER BY last_active_at DESC
      LIMIT 50`,
    [userId],
  );
  return c.json({ items: result.rows.map(toSessionDto) });
});

const CreateSessionBody = z.object({
  label: z.string().trim().min(1).max(80).optional(),
});

// Create a brand-new session — generates a UUID-suffixed thread_id so
// LangGraph's PostgresSaver keeps the new conversation isolated from the
// lifetime ask_vantage:{userId} thread.
routes.post("/sessions", async (c) => {
  const userId = c.get("userId") as string;
  const json = await c.req.json().catch(() => ({}));
  const parsed = CreateSessionBody.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "INVALID_BODY", details: parsed.error.flatten() }, 400);
  }
  // crypto.randomUUID is available in Bun + Node 19+ globals.
  const suffix = crypto.randomUUID();
  const threadId = `ask_vantage:${userId}:${suffix}`;
  const label = parsed.data.label ?? null;
  const inserted = await query<SessionRow>(
    `INSERT INTO conversation_sessions
        (user_id, session_type, agent_type, title, thread_id, message_count)
     VALUES ($1, 'ask_vantage', 'coordinator', $2, $3, 0)
     RETURNING id, thread_id, title, last_preview, message_count,
               last_active_at, created_at`,
    [userId, label, threadId],
  );
  return c.json({ session: toSessionDto(inserted.rows[0]) }, 201);
});

const RenameSessionBody = z.object({
  label: z.string().trim().min(1).max(80),
});

routes.patch("/sessions/:id", async (c) => {
  const userId = c.get("userId") as string;
  const sessionId = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return c.json({ error: "INVALID_ID" }, 400);
  }
  const json = await c.req.json().catch(() => ({}));
  const parsed = RenameSessionBody.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "INVALID_BODY", details: parsed.error.flatten() }, 400);
  }
  const updated = await query<SessionRow>(
    `UPDATE conversation_sessions
        SET title = $3, last_active_at = now()
      WHERE id = $1
        AND user_id = $2
        AND session_type = 'ask_vantage'
      RETURNING id, thread_id, title, last_preview, message_count,
                last_active_at, created_at`,
    [sessionId, userId, parsed.data.label],
  );
  if (updated.rows.length === 0) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }
  return c.json({ session: toSessionDto(updated.rows[0]) });
});

routes.delete("/sessions/:id", async (c) => {
  const userId = c.get("userId") as string;
  const sessionId = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return c.json({ error: "INVALID_ID" }, 400);
  }
  const deleted = await query<{ id: string }>(
    `DELETE FROM conversation_sessions
      WHERE id = $1
        AND user_id = $2
        AND session_type = 'ask_vantage'
      RETURNING id`,
    [sessionId, userId],
  );
  if (deleted.rows.length === 0) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }
  return c.json({ deleted: deleted.rows[0].id });
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
