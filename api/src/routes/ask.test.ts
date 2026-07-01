// Tests for the Ask Vantage gateway (PR2 AG-UI cutover).
//
// The gateway is now a pure pass-through: it injects auth / trace / request id /
// locale headers and streams the upstream AG-UI SSE body back byte-for-byte.
// These tests mock the agents host (global fetch) and assert:
//   - the upstream body is forwarded verbatim (no translation)
//   - the request body is forwarded raw (message AND command pass through)
//   - auth / trace / request / locale headers are injected on the upstream call
//   - upstream-down → 503; upstream-5xx → 502
//   - /recent reads the RECENT rail

import { afterAll, beforeEach, describe, expect, it, mock, test } from "bun:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { config } from "../config";
import { errorHandler } from "../errors";
import { requestId } from "../middleware/observability";
import { traceId } from "../middleware/trace-id";
import type { AppEnv } from "../types";

const USER_A = `user-ask-a-${process.pid}-${process.hrtime.bigint()}`;

// ── DB mock: /recent + /history both touch the DB. ─────────────────────────
let recentRows: { id: string; content: string; created_at: string }[] = [];
// History mocks: the session lookup hits `conversation_sessions WHERE title=`,
// the messages pull hits `conversation_messages WHERE session_id`.
let historySessionRows: { id: string }[] = [];
let historyMessageRows: {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}[] = [];
let lastHistorySessionLookupParams: unknown[] = [];
let lastHistoryMessageLookupParams: unknown[] = [];

// /api/ask/sessions stubs — single-row scratch space the tests reset between
// runs (see `sessionsListRows` / `sessionsInsertRow` / `sessionsPatchRow` /
// `sessionsDeleteRow`). The query stub branches on the SQL fragment that
// identifies each mutator. Keeping each fixture independent stops one test
// from accidentally seeing another's leftovers.
let sessionsListRows: SessionRowFixture[] = [];
let sessionsInsertRow: SessionRowFixture | null = null;
let sessionsPatchRow: SessionRowFixture | null = null;
let sessionsDeleteRow: { id: string } | null = null;
let lastSessionsInsertParams: unknown[] = [];
let lastSessionsPatchParams: unknown[] = [];
let lastSessionsDeleteParams: unknown[] = [];

interface SessionRowFixture {
  id: string;
  thread_id: string | null;
  title: string | null;
  last_preview: string | null;
  message_count: number;
  last_active_at: string;
  created_at: string;
}

async function stubQuery(text: string, params: unknown[]) {
  // /recent: joins sessions + messages, sorted on m.created_at
  if (text.includes("conversation_messages") && text.includes("ORDER BY m.created_at")) {
    return { rows: recentRows };
  }
  // /history step 1: session lookup by user_id + thread_id (with legacy
  // title fallback — migration 019). The COALESCE(...) literal is the
  // structural fingerprint of the new query.
  if (
    text.includes("FROM conversation_sessions") &&
    text.includes("COALESCE(thread_id, title)")
  ) {
    lastHistorySessionLookupParams = params;
    return { rows: historySessionRows };
  }
  // /history step 2: messages by session_id, newest-first
  if (
    text.includes("FROM conversation_messages") &&
    text.includes("ORDER BY created_at DESC")
  ) {
    lastHistoryMessageLookupParams = params;
    return { rows: historyMessageRows };
  }
  // /api/ask/sessions GET list — ORDER BY last_active_at DESC
  if (
    text.includes("FROM conversation_sessions") &&
    text.includes("ORDER BY last_active_at DESC")
  ) {
    return { rows: sessionsListRows };
  }
  // /api/ask/sessions POST create
  if (
    text.includes("INSERT INTO conversation_sessions") &&
    text.includes("'ask_vantage'")
  ) {
    lastSessionsInsertParams = params;
    return { rows: sessionsInsertRow ? [sessionsInsertRow] : [] };
  }
  // /api/ask/sessions PATCH rename
  if (
    text.includes("UPDATE conversation_sessions") &&
    text.includes("SET title = $3")
  ) {
    lastSessionsPatchParams = params;
    return { rows: sessionsPatchRow ? [sessionsPatchRow] : [] };
  }
  // /api/ask/sessions DELETE
  if (
    text.includes("DELETE FROM conversation_sessions") &&
    text.includes("RETURNING id")
  ) {
    lastSessionsDeleteParams = params;
    return { rows: sessionsDeleteRow ? [sessionsDeleteRow] : [] };
  }
  return { rows: [] };
}
mock.module("../db", () => ({ query: stubQuery }));

// ── Agent host mock: capture the forwarded call + return a canned SSE body. ─
const fetchCalls: { url: string; init: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

// A tiny canned AG-UI stream — two data frames, exactly as the agents host
// would emit them. The gateway must forward these untouched.
const CANNED_SSE =
  'data: {"type":"RUN_STARTED","threadId":"t","runId":"r","rawEvent":{"seq":1}}\n\n' +
  'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r","rawEvent":{"seq":2}}\n\n';

let agentResponder: () => Response = () =>
  new Response(CANNED_SSE, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-trace-id": "trace-from-agent" },
  });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  fetchCalls.push({ url, init: init ?? {} });
  return agentResponder();
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const { default: askRoutes } = await import("./ask");
const APP = new Hono<AppEnv>();
APP.use("*", traceId);
APP.use("*", requestId);
APP.route("/api/ask", askRoutes);
APP.onError(errorHandler);

const JWT_SECRET = new TextEncoder().encode(config.JWT_SECRET);
async function makeJwt(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function streamReq(
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return APP.request("/api/ask/stream", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await makeJwt(USER_A)}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ask/stream — pass-through", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    agentResponder = () =>
      new Response(CANNED_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-trace-id": "trace-from-agent" },
      });
  });

  it("requires auth", async () => {
    const res = await APP.request("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(fetchCalls.length).toBe(0);
  });

  it("forwards the upstream SSE body byte-for-byte", async () => {
    const res = await streamReq({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toBe(CANNED_SSE);
  });

  it("forwards the raw request body (message + command) untouched", async () => {
    await streamReq({ message: "", command: { resume: "Stripe" } });
    expect(fetchCalls.length).toBe(1);
    const sent = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(sent.message).toBe("");
    expect(sent.command).toEqual({ resume: "Stripe" });
  });

  it("injects user / trace / request / locale headers on the upstream call", async () => {
    await streamReq(
      { message: "hi" },
      { "X-Relay-Thread-Id": "ask_vantage:abc", "X-Relay-Surface": "dock", "X-Relay-Locale": "zh" },
    );
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Relay-User-Id"]).toBe(USER_A);
    expect(headers["X-Relay-Thread-Id"]).toBe("ask_vantage:abc");
    expect(headers["X-Relay-Surface"]).toBe("dock");
    expect(headers["X-Relay-Locale"]).toBe("zh");
    // trace + request ids are injected by the gateway middleware.
    expect(headers["X-Trace-Id"]).toBeTruthy();
    expect(headers["X-Request-Id"]).toBeTruthy();
  });

  it("propagates the upstream trace id on the response", async () => {
    const res = await streamReq({ message: "hi" });
    expect(res.headers.get("x-trace-id")).toBe("trace-from-agent");
  });

  it("returns 503 when the agent host is unreachable", async () => {
    agentResponder = () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await streamReq({ message: "hi" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("AGENT_UNREACHABLE");
  });

  it("returns 502 when the agent host 5xxs", async () => {
    agentResponder = () =>
      new Response("boom", { status: 500, headers: { "content-type": "text/plain" } });
    const res = await streamReq({ message: "hi" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("AGENT_FAILED");
  });

  it("propagates a 403 from the agent host (IDOR guard)", async () => {
    agentResponder = () =>
      new Response(JSON.stringify({ error: { message: "thread is not yours" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const res = await streamReq({ message: "hi" }, { "X-Relay-Thread-Id": "ask_vantage:other" });
    expect(res.status).toBe(403);
  });

  // D4 (stream-resume-plan): Last-Event-ID must reach the agents host so
  // its resume branch can hand back events past the client's cursor.
  it("forwards the Last-Event-ID request header to the agent host", async () => {
    await streamReq({ message: "" }, { "Last-Event-ID": "42" });
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("42");
  });

  // D3 (stream-resume-plan): the agents host advertises resume via
  // X-Relay-Resume: 1 on the SSE response. Pass it through so the web
  // client can tell resume responses apart from fresh turns.
  it("passes X-Relay-Resume through when the agent host sets it", async () => {
    agentResponder = () =>
      new Response(CANNED_SSE, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-trace-id": "trace-from-agent",
          "x-relay-resume": "1",
        },
      });
    const res = await streamReq({ message: "", last_event_id: 3 });
    expect(res.headers.get("x-relay-resume")).toBe("1");
  });
});

describe("GET /api/ask/recent", () => {
  beforeEach(() => {
    recentRows = [];
  });

  it("requires auth", async () => {
    const res = await APP.request("/api/ask/recent");
    expect(res.status).toBe(401);
  });

  it("returns truncated previews of the user's recent prompts", async () => {
    recentRows = [
      { id: "m1", content: "  tailor my résumé for Stripe   ", created_at: "2026-06-29T00:00:00Z" },
    ];
    const res = await APP.request("/api/ask/recent", {
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("m1");
    expect(body.items[0].preview).toBe("tailor my résumé for Stripe");
  });
});

describe("GET /api/ask/history", () => {
  beforeEach(() => {
    historySessionRows = [];
    historyMessageRows = [];
    lastHistorySessionLookupParams = [];
    lastHistoryMessageLookupParams = [];
  });

  it("requires auth", async () => {
    const res = await APP.request("/api/ask/history");
    expect(res.status).toBe(401);
  });

  it("defaults to the lifetime ask_vantage:{userId} thread when threadId is omitted", async () => {
    historySessionRows = [];
    const res = await APP.request("/api/ask/history", {
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threadId).toBe(`ask_vantage:${USER_A}`);
    expect(body.items).toEqual([]);
    // The session lookup must scope by user_id AND the derived lifetime title.
    expect(lastHistorySessionLookupParams).toEqual([
      USER_A,
      `ask_vantage:${USER_A}`,
    ]);
  });

  it("returns rows in chronological order (oldest first) and shapes them for the dock", async () => {
    historySessionRows = [{ id: "session-xyz" }];
    // Wire shape mirrors `ORDER BY created_at DESC` — newest first. The
    // endpoint must reverse so the dock renders top-to-bottom in time order.
    historyMessageRows = [
      {
        id: "m3",
        role: "assistant",
        content: "Sure — here's a plan.",
        metadata: { trace_id: "abc" },
        created_at: "2026-06-29T01:00:02Z",
      },
      {
        id: "m2",
        role: "user",
        content: "make a plan",
        metadata: null,
        created_at: "2026-06-29T01:00:01Z",
      },
      {
        id: "m1",
        role: "user",
        content: "hello vantage",
        metadata: {},
        created_at: "2026-06-29T01:00:00Z",
      },
    ];
    const res = await APP.request(
      "/api/ask/history?threadId=ask_vantage:" + USER_A,
      { headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threadId).toBe(`ask_vantage:${USER_A}`);
    // ASC after reversal.
    expect(body.items.map((r: { id: string }) => r.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(body.items[0].metadata).toEqual({}); // null normalised to {}
    expect(body.items[2].metadata).toEqual({ trace_id: "abc" });
    expect(body.items[1].role).toBe("user");
    expect(body.items[2].role).toBe("assistant");
    // Both lookups must have happened, the second one scoped to the session
    // returned by the first.
    expect(lastHistorySessionLookupParams).toEqual([
      USER_A,
      `ask_vantage:${USER_A}`,
    ]);
    expect(lastHistoryMessageLookupParams[0]).toBe("session-xyz");
  });

  it("returns an empty list (without throwing) when the session row doesn't exist", async () => {
    historySessionRows = [];
    const res = await APP.request("/api/ask/history?threadId=ask_vantage:" + USER_A, {
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    // No follow-up message lookup is performed when the session is absent.
    expect(lastHistoryMessageLookupParams).toEqual([]);
  });

  it("clamps the limit query to [1, 200]", async () => {
    historySessionRows = [{ id: "session-xyz" }];
    await APP.request("/api/ask/history?limit=99999", {
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(lastHistoryMessageLookupParams[1]).toBe(200);

    await APP.request("/api/ask/history?limit=-5", {
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(lastHistoryMessageLookupParams[1]).toBe(1);
  });

  it("IDOR guard: caller cannot read another user's thread", async () => {
    // Even if the caller knows another user's thread id, the session lookup
    // scopes on `user_id = $1`, so the JOIN comes back empty and we return
    // {items: []} instead of leaking content.
    historySessionRows = [];
    const res = await APP.request("/api/ask/history?threadId=ask_vantage:someone-else", {
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    // The bound user_id parameter is the JWT subject — never the caller-controlled value.
    expect(lastHistorySessionLookupParams[0]).toBe(USER_A);
    expect(lastHistorySessionLookupParams[1]).toBe("ask_vantage:someone-else");
  });
});

// ─── /api/ask/sessions — multi-session CRUD ────────────────────────────────
//
// Covers the four shapes the dock SessionSwitcher exercises: list (with
// label derivation from title vs created_at fallback), create (writes a
// fresh thread_id), rename (404 when row absent / wrong owner), delete
// (404 when row absent). Auth + IDOR are covered by the bound $userId.

describe("/api/ask/sessions", () => {
  beforeEach(() => {
    sessionsListRows = [];
    sessionsInsertRow = null;
    sessionsPatchRow = null;
    sessionsDeleteRow = null;
    lastSessionsInsertParams = [];
    lastSessionsPatchParams = [];
    lastSessionsDeleteParams = [];
  });

  test("GET list returns ordered sessions with derived labels", async () => {
    sessionsListRows = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        thread_id: "ask_vantage:user-a",
        title: "Stripe deep dive",
        last_preview: "What if I tailored for Stripe?",
        message_count: 4,
        last_active_at: "2026-06-30T12:00:00.000Z",
        created_at: "2026-06-29T09:00:00.000Z",
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        // Unnamed row — label falls back to "Conversation · MMM d"
        thread_id: "ask_vantage:user-a:abc",
        title: null,
        last_preview: null,
        message_count: 0,
        last_active_at: "2026-06-30T11:00:00.000Z",
        created_at: "2026-06-30T11:00:00.000Z",
      },
    ];
    const res = await APP.request("/api/ask/sessions", {
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].label).toBe("Stripe deep dive");
    expect(body.items[0].threadId).toBe("ask_vantage:user-a");
    expect(body.items[1].label.startsWith("Conversation · ")).toBe(true);
  });

  test("POST creates a session with a fresh ask_vantage:{userId}:{uuid} thread", async () => {
    sessionsInsertRow = {
      id: "33333333-3333-3333-3333-333333333333",
      // The stub mirrors what the SQL RETURNING clause will emit; the
      // gateway computes thread_id from userId + crypto.randomUUID().
      thread_id: `ask_vantage:${USER_A}:11111111-1111-1111-1111-111111111111`,
      title: null,
      last_preview: null,
      message_count: 0,
      last_active_at: "2026-06-30T12:00:00.000Z",
      created_at: "2026-06-30T12:00:00.000Z",
    };
    const res = await APP.request("/api/ask/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await makeJwt(USER_A)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.id).toBe("33333333-3333-3333-3333-333333333333");
    // The inserted thread_id parameter must be scoped to the authenticated
    // user — anchors the IDOR guard.
    expect(typeof lastSessionsInsertParams[2]).toBe("string");
    expect((lastSessionsInsertParams[2] as string).startsWith(`ask_vantage:${USER_A}:`)).toBe(
      true,
    );
  });

  test("PATCH rename rejects empty label and updates title on success", async () => {
    // Empty label → 400 from zod.
    const bad = await APP.request("/api/ask/sessions/11111111-1111-1111-1111-111111111111", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${await makeJwt(USER_A)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "   " }),
    });
    expect(bad.status).toBe(400);

    sessionsPatchRow = {
      id: "11111111-1111-1111-1111-111111111111",
      thread_id: "ask_vantage:user-a",
      title: "Renamed",
      last_preview: null,
      message_count: 4,
      last_active_at: "2026-06-30T12:00:00.000Z",
      created_at: "2026-06-29T09:00:00.000Z",
    };
    const ok = await APP.request("/api/ask/sessions/11111111-1111-1111-1111-111111111111", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${await makeJwt(USER_A)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "Renamed" }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.session.label).toBe("Renamed");
    expect(lastSessionsPatchParams[1]).toBe(USER_A);
  });

  test("DELETE returns 404 when the row does not belong to the caller", async () => {
    sessionsDeleteRow = null; // not found / not owned
    const res = await APP.request("/api/ask/sessions/11111111-1111-1111-1111-111111111111", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await makeJwt(USER_A)}` },
    });
    expect(res.status).toBe(404);
    // IDOR check: the bound user_id is always the JWT subject.
    expect(lastSessionsDeleteParams[1]).toBe(USER_A);
  });

  test("PATCH with invalid uuid returns 400 before touching the DB", async () => {
    const res = await APP.request("/api/ask/sessions/not-a-uuid", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${await makeJwt(USER_A)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(400);
    expect(lastSessionsPatchParams).toEqual([]);
  });
});
