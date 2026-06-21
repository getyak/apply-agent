import Redis from "ioredis";
import { config } from "./config";

// Lazy Redis client — only connects on first use, not at module-import
// time. This lets test files that import `../redis` (e.g. via middleware
// that passes `redisClient = redis`) import the module with zero I/O.
// In test mode (Bun.env.NODE_ENV === "test" or Bun.isMainThread === false
// during bun test), we return a no-op stub so every test file avoids
// the ioredis retry backoff without needing per-file mock.module().
let redis: Redis | null = null;

function getRedis(): Redis {
  if (redis) return redis;

  // Detect test environment: set NODE_ENV=test in CI for tests,
  // or rely on Bun's test runner behavior.
  if (process.env.NODE_ENV === "test") {
    // NOOP stub — every method returns a resolved no-op so the
    // rate-limiter, idempotency middleware, and cache all fail-open
    // immediately instead of spending 4s on ioredis retry backoff.
    const noop = async () => {};
    redis = {
      get: async () => null,
      set: async () => "OK" as const,
      incr: async () => 1,
      expire: async () => 1,
      pttl: async () => -1,
      ping: async () => "PONG" as const,
      on: () => redis!,
      quit: noop,
      disconnect: noop,
      status: "end",
    } as unknown as Redis;
    return redis;
  }

  redis = new Redis(config.REDIS_URL, {
    // REDIS-bundle (round-13): the round-13 redis-lifecycle audit found
    // we had no retry strategy and no error listener — an idle client
    // dying would crash Node, and a transient outage would surface as
    // immediate request failures instead of the bounded retries ioredis
    // can do for us. The defaults below are tenacity-style exponential
    // backoff capped at 2 s per attempt and 3 attempts per command, so
    // every rate-limit / cache call gets the same brief grace window as
    // the PG pool.
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });

  // REDIS-bundle (round-13): ioredis emits `'error'` when the underlying
  // socket dies. Without a listener Node crashes on the next tick;
  // catching it lets ioredis's retryStrategy reconnect transparently.
  redis.on("error", (err) => {
    console.error(`[redis] client error: ${err.message}`);
  });
  return redis;
}

let shutdownInstalled = false;
/**
 * REDIS-bundle (round-13): install SIGTERM / SIGINT handlers that
 * quit the client on graceful shutdown. Mirrors api/src/db.ts so a
 * rolling deploy drains both PG and Redis instead of yanking the
 * sockets out from under in-flight requests. Idempotent.
 */
export function installRedisShutdownHandlers(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const client = getRedis();
  const quit = async (signal: string) => {
    console.log(`[redis] received ${signal}, quitting…`);
    try {
      await client.quit();
      console.log("[redis] client quit");
    } catch (err) {
      console.error(
        `[redis] error during quit: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  process.once("SIGTERM", () => void quit("SIGTERM"));
  process.once("SIGINT", () => void quit("SIGINT"));
}

/**
 * REDIS-bundle (round-13): probe Redis once at boot so a misconfigured
 * REDIS_URL fails fast in logs instead of silently turning every
 * cache / rate-limit / idempotency lookup into a runtime error on the
 * first request. The mirror of api/src/db.ts:pingDbAtBoot — the
 * readiness probe stays the source of truth for traffic-routing
 * decisions; this is the boot-time breadcrumb.
 */
export async function pingRedisAtBoot(): Promise<boolean> {
  try {
    await getRedis().ping();
    return true;
  } catch (err) {
    console.warn(
      `[redis] boot ping failed (will keep serving — readiness probe will reflect this): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

// Proxy: lazily resolves to getRedis() on first property access.
// This ensures that `import redis from "../redis"` never triggers
// an I/O connection at module-import time — only when the caller
// first uses `redis.get()`, `redis.set()`, etc.
const handler: ProxyHandler<Record<string, unknown>> = {
  get(target, prop: string | symbol) {
    return (getRedis() as any)[prop];
  },
  has(target, prop: string | symbol) {
    return prop in getRedis();
  },
};

export default new Proxy({} as Record<string, unknown>, handler) as unknown as Redis;
