import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { config } from "../config";
import { errorHandler } from "../errors";
import type { AppEnv } from "../types";

const USER_ID = "00000000-0000-4000-8000-000000000e01";
const OPERATION_ID = "00000000-0000-4000-8000-000000000e02";
let rows: Record<string, unknown>[] = [];
let lastParams: unknown[] = [];
let queryCalls = 0;

mock.module("../db", () => ({
  query: async (_sql: string, params: unknown[]) => {
    queryCalls += 1;
    lastParams = params;
    return { rows };
  },
}));

const { default: operationRoutes } = await import("./operations");
const app = new Hono<AppEnv>();
app.route("/api/operations", operationRoutes);
app.onError(errorHandler);

async function request(operationId = OPERATION_ID) {
  const token = await new SignJWT({ sub: USER_ID })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.JWT_SECRET));
  return app.request(`/api/operations/${operationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("operation status route", () => {
  beforeEach(() => {
    rows = [];
    lastParams = [];
    queryCalls = 0;
  });

  it("returns the owner-scoped recovery envelope", async () => {
    rows = [
      {
        id: OPERATION_ID,
        status: "reconciling",
        result: null,
        error_class: "ambiguous_effect",
        error_code: "EFFECT_INCONCLUSIVE",
        error_message: "Outcome is not yet proven",
        attempt_count: 1,
        reconcile_count: 2,
        next_attempt_at: "2026-08-08T12:00:00.000Z",
      },
    ];

    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(lastParams).toEqual([OPERATION_ID, USER_ID]);
    expect(body.recovery.action).toBe("reconcile");
    expect(body.error.class).toBe("ambiguous_effect");
    expect(body.recovery.reconcile_attempt).toBe(2);
    expect(body.recovery.max_attempts).toBeNull();
    expect(body.recovery.max_reconcile_attempts).toBe(3);
  });

  it("does not disclose another user's operation", async () => {
    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("rejects a malformed operation id before PostgreSQL", async () => {
    const response = await request("not-a-uuid");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(queryCalls).toBe(0);
  });
});
