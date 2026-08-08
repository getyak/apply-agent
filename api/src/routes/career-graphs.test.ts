import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { config } from "../config";
import { errorHandler } from "../errors";
import type { AppEnv } from "../types";
import careerGraphRoutes from "./career-graphs";

const USER_ID = "00000000-0000-4000-8000-000000000c01";
const RESUME_ID = "00000000-0000-4000-8000-000000000c02";
const GRAPH_ID = "00000000-0000-4000-8000-000000000c03";
const CHANGE_ID = "00000000-0000-4000-8000-000000000c04";

type FetchCall = { url: string; init: RequestInit };
const fetchCalls: FetchCall[] = [];
let agentResponder = () =>
  new Response(JSON.stringify({ graphs: [], source_resumes: [], pending_changes: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  fetchCalls.push({
    url: typeof input === "string" ? input : input.toString(),
    init: init ?? {},
  });
  return agentResponder();
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const app = new Hono<AppEnv>();
app.route("/api/career-graphs", careerGraphRoutes);
app.onError(errorHandler);

const jwtSecret = new TextEncoder().encode(config.JWT_SECRET);
async function token() {
  return new SignJWT({ sub: USER_ID })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(jwtSecret);
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
}

describe("Career Graph gateway", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    agentResponder = () =>
      new Response(
        JSON.stringify({ graphs: [], source_resumes: [], pending_changes: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
  });

  it("forwards the JWT owner through the standard agent HTTP boundary", async () => {
    const response = await request("/api/career-graphs");

    expect(response.status).toBe(200);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toEndWith("/career-graphs");
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Relay-User-Id"]).toBe(USER_ID);
  });

  it("maps camelCase import input to the Python contract", async () => {
    agentResponder = () =>
      new Response(
        JSON.stringify({ id: CHANGE_ID, status: "pending" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const response = await request("/api/career-graphs/import", {
      method: "POST",
      body: JSON.stringify({
        resumeId: RESUME_ID,
        graphId: GRAPH_ID,
        graphLabel: "Primary",
      }),
    });

    expect(response.status).toBe(200);
    const payload = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(payload).toEqual({
      resume_id: RESUME_ID,
      graph_id: GRAPH_ID,
      graph_label: "Primary",
    });
  });

  it("forwards an exact decision and preserves the agent response", async () => {
    agentResponder = () =>
      new Response(
        JSON.stringify({ change_set_id: CHANGE_ID, status: "approved", revision: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const confirmation = `APPROVE CAREER CHANGE ${CHANGE_ID}`;

    const response = await request(
      `/api/career-graphs/changes/${CHANGE_ID}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "approve", confirmation }),
      },
    );

    expect(response.status).toBe(200);
    expect(fetchCalls[0]!.url).toEndWith(
      `/career-graph-changes/${CHANGE_ID}/decision`,
    );
    expect(JSON.parse(fetchCalls[0]!.init.body as string)).toEqual({
      decision: "approve",
      confirmation,
    });
    expect((await response.json()).revision).toBe(1);
  });

  it("rejects malformed ids before calling the agent", async () => {
    const response = await request("/api/career-graphs/changes/not-a-uuid");

    expect(response.status).toBe(404);
    expect(fetchCalls.length).toBe(0);
  });

  it("passes through the agent's owner-safe conflict envelope", async () => {
    agentResponder = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "RESOURCE_CONFLICT",
            message: "change set is already approved",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );

    const response = await request(
      `/api/career-graphs/changes/${CHANGE_ID}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: "approve",
          confirmation: `APPROVE CAREER CHANGE ${CHANGE_ID}`,
        }),
      },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("RESOURCE_CONFLICT");
  });
});
