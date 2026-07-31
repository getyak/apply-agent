import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { config } from "../config";
import { errorHandler } from "../errors";
import type { AppEnv } from "../types";

const USER_ID = "00000000-0000-4000-8000-000000000111";
const REQUEST_ID = "00000000-0000-4000-8000-000000000222";
const CLIENT_ID = "codex-test-client";

type Row = {
  id: string;
  client_id: string;
  client_metadata: Record<string, unknown>;
  user_id: string | null;
  redirect_uri: string;
  state: string;
  scopes: string[];
  resource: string;
  status: "pending" | "approved" | "denied" | "consumed";
  expires_at: Date;
};

let row: Row;
let storedCodeHash: string | null;

function resetRow() {
  row = {
    id: REQUEST_ID,
    client_id: CLIENT_ID,
    client_metadata: {
      client_id: CLIENT_ID,
      client_name: "Codex Test",
    },
    user_id: null,
    redirect_uri: "http://127.0.0.1:1455/callback?existing=1",
    state: "state-123",
    scopes: ["career:read", "career:write"],
    resource: "http://127.0.0.1:8002/mcp",
    status: "pending",
    expires_at: new Date(Date.now() + 60_000),
  };
  storedCodeHash = null;
}

async function stubQuery(text: string) {
  if (text.includes("FROM mcp_oauth_authorization_requests")) {
    return { rows: [row] };
  }
  return { rows: [] };
}

const tx = {
  async query(text: string, params: unknown[] = []) {
    if (text.includes("FOR UPDATE OF r")) return { rows: [row] };
    if (text.includes("status = 'approved'")) {
      row = { ...row, user_id: String(params[1]), status: "approved" };
      storedCodeHash = String(params[2]);
      return { rows: [] };
    }
    if (text.includes("status = 'denied'")) {
      row = { ...row, user_id: String(params[1]), status: "denied" };
      return { rows: [] };
    }
    return { rows: [] };
  },
};

mock.module("../db", () => ({
  query: stubQuery,
  withTransaction: async <T>(callback: (client: typeof tx) => Promise<T>) =>
    callback(tx),
}));

const { default: mcpOAuthRoutes } = await import("./mcp-oauth");
const APP = new Hono<AppEnv>();
APP.route("/api/mcp-oauth", mcpOAuthRoutes);
APP.onError(errorHandler);

async function jwt(): Promise<string> {
  return new SignJWT({ sub: USER_ID })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.JWT_SECRET));
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return APP.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${await jwt()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("MCP OAuth consent bridge", () => {
  beforeEach(resetRow);

  it("requires a signed-in Relay user", async () => {
    const response = await APP.request(
      `/api/mcp-oauth/requests/${REQUEST_ID}`,
    );
    expect(response.status).toBe(401);
  });

  it("returns only public client and scope details", async () => {
    const response = await request(
      `/api/mcp-oauth/requests/${REQUEST_ID}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.request.client.name).toBe("Codex Test");
    expect(body.request.scopes).toEqual(["career:read", "career:write"]);
    expect(JSON.stringify(body)).not.toContain("redirect_uri");
    expect(JSON.stringify(body)).not.toContain("authorization_code");
  });

  it("binds approval to the JWT subject and persists only a code digest", async () => {
    const response = await request(
      `/api/mcp-oauth/requests/${REQUEST_ID}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const redirect = new URL(body.redirectUrl);
    const rawCode = redirect.searchParams.get("code");
    expect(redirect.origin).toBe("http://127.0.0.1:1455");
    expect(redirect.searchParams.get("existing")).toBe("1");
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(rawCode).toStartWith("relay_ac_");
    expect(row.user_id).toBe(USER_ID);
    expect(row.status).toBe("approved");
    expect(storedCodeHash).toHaveLength(64);
    expect(storedCodeHash).toBe(
      createHash("sha256").update(rawCode!).digest("hex"),
    );
    expect(storedCodeHash).not.toContain(rawCode!);
  });

  it("returns access_denied to the registered callback on denial", async () => {
    const response = await request(
      `/api/mcp-oauth/requests/${REQUEST_ID}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const redirect = new URL(body.redirectUrl);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(row.user_id).toBe(USER_ID);
    expect(row.status).toBe("denied");
  });

  it("rejects a repeated decision", async () => {
    row.status = "approved";
    row.user_id = USER_ID;
    const response = await request(
      `/api/mcp-oauth/requests/${REQUEST_ID}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(response.status).toBe(409);
  });
});
