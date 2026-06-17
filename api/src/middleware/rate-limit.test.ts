import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Redis } from "ioredis";
import { errorHandler } from "../errors";
import type { AppEnv } from "../types";
import { consume, defaultActorKey, rateLimit } from "./rate-limit";

// Minimal in-memory Redis stub. We only model the three ops the limiter uses
// (INCR, EXPIRE, PTTL); anything else throws so a misuse surfaces in tests.
class FakeRedis {
  values = new Map<string, number>();
  ttls = new Map<string, number>(); // ms remaining
  errorOn: string | null = null;

  async incr(key: string): Promise<number> {
    if (this.errorOn === "incr") throw new Error("simulated redis outage");
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds * 1000);
    return 1;
  }

  async pttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -1;
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

describe("consume", () => {
  test("allows requests up to the limit, then blocks", async () => {
    const r = new FakeRedis();
    const c = asRedis(r);

    const r1 = await consume(c, "rl:test:user:1", 2, 60);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);

    const r2 = await consume(c, "rl:test:user:1", 2, 60);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);

    const r3 = await consume(c, "rl:test:user:1", 2, 60);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  test("only sets TTL on the first hit so the window actually expires", async () => {
    const r = new FakeRedis();
    const c = asRedis(r);
    await consume(c, "rl:test:user:1", 5, 30);
    const firstTtl = r.ttls.get("rl:test:user:1");
    expect(firstTtl).toBe(30_000);

    // A second call must not extend the TTL — otherwise a steady stream of
    // requests could pin the window open forever.
    r.ttls.set("rl:test:user:1", 1_000);
    await consume(c, "rl:test:user:1", 5, 30);
    expect(r.ttls.get("rl:test:user:1")).toBe(1_000);
  });
});

describe("defaultActorKey", () => {
  test("falls back to ip:<addr> from x-forwarded-for (first hop wins)", async () => {
    const app = new Hono<AppEnv>();
    let observed = "";
    app.get("/", (c) => {
      observed = defaultActorKey(c);
      return c.json({});
    });
    await app.request("/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    // First entry wins (the original client IP).
    expect(observed).toBe("ip:203.0.113.7");
  });

  test("returns ip:unknown when no forwarding headers are present", async () => {
    const app = new Hono<AppEnv>();
    let observed = "";
    app.get("/", (c) => {
      observed = defaultActorKey(c);
      return c.json({});
    });
    await app.request("/");
    expect(observed).toBe("ip:unknown");
  });
});

describe("rateLimit middleware", () => {
  test("stamps rate-limit headers on a permitted request", async () => {
    const fake = new FakeRedis();
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        scope: "test",
        limit: 3,
        windowSeconds: 60,
        keyFor: () => "user:abc",
        redisClient: asRedis(fake),
      }),
    );
    app.get("/", (c) => c.json({ ok: true }));
    app.onError(errorHandler);

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("2");
  });

  test("returns 429 with Retry-After once the limit is exhausted", async () => {
    const fake = new FakeRedis();
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        scope: "test",
        limit: 1,
        windowSeconds: 60,
        keyFor: () => "user:abc",
        redisClient: asRedis(fake),
      }),
    );
    app.get("/", (c) => c.json({ ok: true }));
    app.onError(errorHandler);

    await app.request("/"); // consumes the single allowed call
    const blocked = await app.request("/");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  test("skips the limiter when keyFor returns null", async () => {
    const fake = new FakeRedis();
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        scope: "test",
        limit: 1,
        windowSeconds: 60,
        keyFor: () => null,
        redisClient: asRedis(fake),
      }),
    );
    app.get("/", (c) => c.json({ ok: true }));

    // Three hits, all 200 — the limiter is bypassed entirely.
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request("/");
      expect(res.status).toBe(200);
    }
    expect(fake.values.size).toBe(0);
  });

  test("fails open when Redis errors so the limiter never takes down the API", async () => {
    const fake = new FakeRedis();
    fake.errorOn = "incr";
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        scope: "test",
        limit: 1,
        windowSeconds: 60,
        keyFor: () => "user:abc",
        redisClient: asRedis(fake),
      }),
    );
    app.get("/", (c) => c.json({ ok: true }));
    app.onError(errorHandler);

    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});
