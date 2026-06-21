import Redis from "ioredis";
import { config } from "./config";

const redis = new Redis(config.REDIS_URL, {
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
  const quit = async (signal: string) => {
    console.log(`[redis] received ${signal}, quitting…`);
    try {
      await redis.quit();
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
    await redis.ping();
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

export default redis;
