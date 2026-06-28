import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Redis } from "ioredis";
import { errorHandler } from "../errors";
import type { AppEnv } from "../types";
import { idempotency } from "./idempotency";

// Minimal in-memory Redis stub covering the three ops idempotency uses:
// GET, SET (with EX). Anything else throws so misuse surfaces in tests.
class FakeRedis {
  store = new Map<string, { value: string; expiresAt: number }>();
  errorOnGet = false;
  errorOnSet = false;

  async get(key: string): Promise<string | null> {
    if (this.errorOnGet) throw new Error("simulated redis outage");
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, _mode: "EX", ttlSeconds: number): Promise<"OK"> {
    if (this.errorOnSet) throw new Error("simulated redis outage");
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return "OK";
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

// Helper: build an app with auth stub + idempotency + a simple POST handler
// that increments a counter so we can assert whether it ran.
function makeApp(fake: FakeRedis, userId = "user-test-123") {
  const app = new Hono<AppEnv>();
  let handlerCalls = 0;

  // Stub authMiddleware: set userId on every request.
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });

  app.use(
    "/*",
    idempotency({ redisClient: asRedis(fake) }),
  );

  app.post("/action", (c) => {
    handlerCalls += 1;
    return c.json({ ran: handlerCalls }, 201);
  });

  app.onError(errorHandler);

  return { app, getHandlerCalls: () => handlerCalls };
}

describe("idempotency middleware", () => {
  test("missing header → passthrough, handler runs normally", async () => {
    const fake = new FakeRedis();
    const { app, getHandlerCalls } = makeApp(fake);

    const res = await app.request("/action", { method: "POST" });
    expect(res.status).toBe(201);
    expect(getHandlerCalls()).toBe(1);
    // No key → nothing stored in Redis.
    expect(fake.store.size).toBe(0);
  });

  test("first call with valid key → handler runs, response stored", async () => {
    const fake = new FakeRedis();
    const { app, getHandlerCalls } = makeApp(fake);

    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "a".repeat(16) },
    });
    expect(res.status).toBe(201);
    expect(getHandlerCalls()).toBe(1);
    // Response must be stored in Redis.
    expect(fake.store.size).toBe(1);
    // Replay header must NOT be present on the first call.
    expect(res.headers.get("X-Idempotent-Replay")).toBeNull();
    const body = (await res.json()) as { ran: number };
    expect(body.ran).toBe(1);
  });

  test("second call with same key → handler NOT invoked, response replayed", async () => {
    const fake = new FakeRedis();
    const { app, getHandlerCalls } = makeApp(fake);
    const key = "b".repeat(20);

    // First call.
    await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(getHandlerCalls()).toBe(1);

    // Second call with same key.
    const res2 = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(res2.status).toBe(201);
    // Handler must NOT have run again.
    expect(getHandlerCalls()).toBe(1);
    // Replay header must be set.
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
    const body = (await res2.json()) as { ran: number };
    // Replayed body still reflects the first call's counter value.
    expect(body.ran).toBe(1);
  });

  test("key too short (< 16 chars) → 400", async () => {
    const fake = new FakeRedis();
    const { app } = makeApp(fake);

    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "short" }, // 5 chars
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  test("key too long (> 128 chars) → 400", async () => {
    const fake = new FakeRedis();
    const { app } = makeApp(fake);

    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "x".repeat(129) },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  test("exactly 16-char key → accepted", async () => {
    const fake = new FakeRedis();
    const { app } = makeApp(fake);

    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "c".repeat(16) },
    });
    expect(res.status).toBe(201);
  });

  test("exactly 128-char key → accepted", async () => {
    const fake = new FakeRedis();
    const { app } = makeApp(fake);

    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "d".repeat(128) },
    });
    expect(res.status).toBe(201);
  });

  test("Redis GET error → fail-open, handler runs", async () => {
    const fake = new FakeRedis();
    fake.errorOnGet = true;
    const { app, getHandlerCalls } = makeApp(fake);

    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "e".repeat(16) },
    });
    // Should still succeed — fail-open.
    expect(res.status).toBe(201);
    expect(getHandlerCalls()).toBe(1);
  });

  test("Redis SET error after first call → response returned, no crash", async () => {
    const fake = new FakeRedis();
    fake.errorOnSet = true;
    const { app, getHandlerCalls } = makeApp(fake);

    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "f".repeat(16) },
    });
    // Handler should still have run and returned normally.
    expect(res.status).toBe(201);
    expect(getHandlerCalls()).toBe(1);
    // Nothing was stored (SET failed).
    expect(fake.store.size).toBe(0);
  });

  test("different users get different idempotency scopes", async () => {
    const fake = new FakeRedis();
    const key = "g".repeat(16);

    const { app: appA, getHandlerCalls: callsA } = makeApp(fake, "user-A");
    const { app: appB, getHandlerCalls: callsB } = makeApp(fake, "user-B");

    await appA.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    // User B with same key should NOT see user A's cached response.
    const resB = await appB.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(resB.headers.get("X-Idempotent-Replay")).toBeNull();
    expect(callsA()).toBe(1);
    expect(callsB()).toBe(1);
  });
});
