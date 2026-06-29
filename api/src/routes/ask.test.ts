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

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { config } from "../config";
import { errorHandler } from "../errors";
import { requestId } from "../middleware/observability";
import { traceId } from "../middleware/trace-id";
import type { AppEnv } from "../types";

const USER_A = `user-ask-a-${process.pid}-${process.hrtime.bigint()}`;

// ── DB mock: only /recent touches it. ──────────────────────────────────────
let recentRows: { id: string; content: string; created_at: string }[] = [];
async function stubQuery(text: string, _params: unknown[]) {
  if (text.includes("conversation_messages") && text.includes("ORDER BY m.created_at")) {
    return { rows: recentRows };
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
