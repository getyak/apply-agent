/**
 * T3b — /api/applications/prepare-from-jd
 *
 * Verifies the TS gateway:
 *   - 409 when the user has no base résumé yet
 *   - 502 with an upstream-style error when the Python agent returns 5xx
 *   - 200 forwarding the agent's payload when the saga completes
 *
 * No real PG, no real agent — query() and global fetch are both module-mocked.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { config } from "../config";
import { errorHandler } from "../errors";
import type { AppEnv } from "../types";

// TEST_RL1 (round-16): hard-coded user id meant the rate-limit
// middleware (round-7 API_RL1, 5/60s on /prepare-from-jd, keyed on
// user id via real Redis when the bundle from round-13 is up) leaked
// state across consecutive test runs — the 60s window shared a key,
// and consecutive `bun test` invocations within the same minute saw
// 429s on tests 2-4. Use a per-process suffix so each run gets a
// fresh rate-limit bucket. The mocked stubQuery treats any user id
// the same, so the suffix is invisible to the rest of the test.
const USER_A = `user-prepare-a-${process.pid}-${process.hrtime.bigint()}`;
const RESUME_ID = "00000000-0000-0000-0000-000000000bb1";
const APPLICATION_ID = "00000000-0000-0000-0000-000000000cc1";
const JOB_ID = "00000000-0000-0000-0000-000000000dd1";

let hasBaseResume = true;
let hasOwnedApplication = true;
let agentResponder: () => Response = () =>
  new Response(JSON.stringify({ application_id: "app-001", status: "review" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function stubQuery(text: string, params: unknown[]) {
  if (text.includes("FROM resumes") && text.includes("is_base = TRUE")) {
    if (!hasBaseResume) return { rows: [] };
    return {
      rows: [
        {
          id: RESUME_ID,
          version: 3,
          content: { basics: { name: "Alice Engineer" } },
        },
      ],
    };
  }
  if (text.includes("FROM application_drafts ad") && text.includes("JOIN jobs")) {
    if (!hasOwnedApplication) return { rows: [] };
    return {
      rows: [
        {
          id: JOB_ID,
          jd_text: "Build reliable backend services with TypeScript and PostgreSQL.",
          parsed: {},
          company: "Relay Labs",
          role_title: "Backend Engineer",
        },
      ],
    };
  }
  if (text.includes("COUNT(*)")) return { rows: [{ total: 0 }] };
  return { rows: [] };
}

mock.module("../db", () => ({ query: stubQuery }));
mock.module("../cache", () => ({
  cache: { getOrSet: async (_ns: string, _k: unknown[], fn: () => unknown) => fn() },
}));
mock.module("../llm", () => ({
  llm: { available: false },
  LLMUnavailableError: class LLMUnavailableError extends Error {},
}));

// Capture agent fetches so tests can inspect what got forwarded.
const fetchCalls: { url: string; init: RequestInit }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  fetchCalls.push({ url, init: init ?? {} });
  return agentResponder();
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const { default: applicationRoutes } = await import("./applications");
const APP = new Hono<AppEnv>();
APP.route("/api/applications", applicationRoutes);
APP.onError(errorHandler);

const JWT_SECRET = new TextEncoder().encode(config.JWT_SECRET);
async function makeJwt(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function req(body: unknown): Promise<Response> {
  return APP.request("/api/applications/prepare-from-jd", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await makeJwt(USER_A)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ applicationId: APPLICATION_ID, ...(body as object) }),
  });
}

describe("POST /api/applications/prepare-from-jd", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    hasBaseResume = true;
    hasOwnedApplication = true;
    agentResponder = () =>
      new Response(
        JSON.stringify({ application_id: "app-001", status: "review" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
  });

  it("returns 409 when the user has no base résumé", async () => {
    hasBaseResume = false;
    const res = await req({ jdUrl: "https://boards.greenhouse.io/synthetic/jobs/4071234" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("RESOURCE_CONFLICT");
    // No agent call should have happened.
    expect(fetchCalls.length).toBe(0);
  });

  it("forwards to the agent and returns the payload on success", async () => {
    const res = await req({
      jdUrl: "https://boards.greenhouse.io/synthetic/jobs/4071234",
      formFields: [{ id: "first_name", label: "First Name", type: "text" }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.application_id).toBe("app-001");
    expect(body.status).toBe("review");

    // Agent called exactly once with the right shape.
    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0]!;
    expect(call.url).toContain("/applications/prepare");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-relay-user-id"]).toBe(USER_A);
    const payload = JSON.parse(call.init.body as string);
    expect(payload.jd_url).toBe("https://boards.greenhouse.io/synthetic/jobs/4071234");
    expect(payload.base_resume_id).toBe(RESUME_ID);
    expect(payload.base_resume_version).toBe(3);
    expect(payload.base_resume_content.basics.name).toBe("Alice Engineer");
    expect(payload.form_fields).toEqual([
      { id: "first_name", label: "First Name", type: "text" },
    ]);
  });

  it("forwards an ownership-checked stored JD instead of forcing a refetch", async () => {
    const res = await req({
      jdUrl: "https://jobs.example.test/roles/backend",
      applicationId: APPLICATION_ID,
    });
    expect(res.status).toBe(200);
    const payload = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(payload.application_id).toBe(APPLICATION_ID);
    expect(payload.job_id).toBe(JOB_ID);
    expect(payload.jd_text).toContain("TypeScript and PostgreSQL");
    expect(payload.company).toBe("Relay Labs");
    expect(payload.role_title).toBe("Backend Engineer");
  });

  it("rejects a missing or foreign application before calling the agent", async () => {
    hasOwnedApplication = false;
    const res = await req({
      jdUrl: "https://jobs.example.test/roles/backend",
      applicationId: APPLICATION_ID,
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("RESOURCE_NOT_FOUND");
    expect(fetchCalls.length).toBe(0);
  });

  it("requires a canonical draft before starting agent work", async () => {
    const res = await APP.request("/api/applications/prepare-from-jd", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await makeJwt(`${USER_A}-missing-draft`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jdUrl: "https://jobs.example.test/roles/backend",
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(fetchCalls.length).toBe(0);
  });

  it("returns 502 (UPSTREAM) when the agent errors", async () => {
    agentResponder = () =>
      new Response("agent boom", { status: 500 });
    const res = await req({ jdUrl: "https://boards.greenhouse.io/synthetic/jobs/4071234" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("returns 401 when no JWT is presented", async () => {
    const res = await APP.request("/api/applications/prepare-from-jd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jdUrl: "https://boards.greenhouse.io/synthetic/jobs/4071234",
        applicationId: APPLICATION_ID,
      }),
    });
    expect(res.status).toBe(401);
    expect(fetchCalls.length).toBe(0);
  });

  // Locale propagation: rubric-10 case for the round-20 deep loop.
  // Mirrors /api/ask/stream — agent reply language pinned by X-Relay-Locale.
  it("forwards X-Relay-Locale from explicit header to the agent", async () => {
    const res = await APP.request("/api/applications/prepare-from-jd", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await makeJwt(USER_A)}`,
        "Content-Type": "application/json",
        "X-Relay-Locale": "zh",
      },
      body: JSON.stringify({
        jdUrl: "https://boards.greenhouse.io/synthetic/jobs/4071234",
        applicationId: APPLICATION_ID,
      }),
    });
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(1);
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Relay-Locale"]).toBe("zh");
  });

  it("falls back to Accept-Language when X-Relay-Locale is absent", async () => {
    const res = await APP.request("/api/applications/prepare-from-jd", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await makeJwt(USER_A)}`,
        "Content-Type": "application/json",
        "Accept-Language": "zh-CN,en;q=0.7",
      },
      body: JSON.stringify({
        jdUrl: "https://boards.greenhouse.io/synthetic/jobs/4071234",
        applicationId: APPLICATION_ID,
      }),
    });
    expect(res.status).toBe(200);
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Relay-Locale"]).toBe("zh");
  });

  it("defaults to en when neither header is provided", async () => {
    const res = await req({ jdUrl: "https://boards.greenhouse.io/synthetic/jobs/4071234" });
    expect(res.status).toBe(200);
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Relay-Locale"]).toBe("en");
  });
});
