import type { Context, Next } from "hono";
import type { Redis } from "ioredis";
import redis from "../redis";
import { RateLimitedError } from "../errors";
import type { AppEnv } from "../types";

// Sliding-window rate limiter backed by Redis (token bucket via INCR+EXPIRE).
//
// Why a fixed-window INCR over a true sliding log:
//   - INCR + EXPIRE is two ops, atomic enough for our throughput, no LUA needed.
//   - Sliding-log gives sub-window precision but multiplies memory by request
//     count; we don't need that precision for the abuse patterns we care about
//     (brute-forcing /auth/login, spamming billable LLM routes).
//
// The default key derivation peels off the auth scope (`user:<id>` once signed
// in, `ip:<addr>` otherwise) so the limit follows the actor, not the route.
// Callers override `keyFor` for per-endpoint scoping (auth endpoints want IP
// limits even after login).

export interface RateLimitOptions {
  /**
   * Logical scope name. Becomes part of the Redis key so two limiters using the
   * same actor don't share a counter.
   *   `rl:auth:ip:1.2.3.4` vs `rl:llm:user:abc-uuid`
   */
  scope: string;
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Override the actor key derivation. Defaults to user id (if authed) or
   * client IP. Return `null` to skip the limiter for this request (e.g. an
   * allowlisted health probe).
   */
  keyFor?: (c: Context<AppEnv>) => string | null;
  /** Inject a Redis client for tests. */
  redisClient?: Redis;
}

/** Default actor: authenticated user id, falling back to client IP. */
export function defaultActorKey(c: Context<AppEnv>): string {
  const userId = c.get("userId" as never) as string | undefined;
  if (userId) return `user:${userId}`;
  // Prefer the standard reverse-proxy header; the API normally sits behind
  // a Railway / Vercel edge. Fall back to the runtime's reported remote addr.
  const forwarded = c.req.header("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
  return `ip:${ip}`;
}

export interface LimitResult {
  allowed: boolean;
  /** Remaining requests in the current window after this one would be counted. */
  remaining: number;
  /** Seconds until the limit window resets. */
  resetSeconds: number;
}

/**
 * Apply the limiter for one actor. Exposed for tests so we can assert behavior
 * without Hono. Uses INCR (atomic) + a conditional EXPIRE on the first hit so
 * the window key never lives forever after a single request.
 */
export async function consume(
  client: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<LimitResult> {
  const count = await client.incr(key);
  // Only set TTL when the key was just created — otherwise we'd extend the
  // window on every request and the limit would never actually reset.
  if (count === 1) {
    await client.expire(key, windowSeconds);
  }
  // pttl gives millisecond precision; -1 means "no TTL" (shouldn't happen
  // after our expire above, but guard so we still report something sane).
  const pttl = await client.pttl(key);
  const resetSeconds = pttl > 0 ? Math.ceil(pttl / 1000) : windowSeconds;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetSeconds,
  };
}

/**
 * Build a rate-limit middleware. Returns a Hono handler that throws
 * RateLimitedError (mapped to a 429 envelope) when the actor exceeds the
 * configured budget inside the window, and otherwise stamps the standard
 * `X-RateLimit-*` headers on the response.
 */
export function rateLimit(options: RateLimitOptions) {
  const {
    scope,
    limit,
    windowSeconds,
    keyFor = defaultActorKey,
    redisClient = redis,
  } = options;

  return async (c: Context<AppEnv>, next: Next) => {
    const actor = keyFor(c);
    if (actor === null) {
      await next();
      return;
    }
    const key = `rl:${scope}:${actor}`;

    let result: LimitResult;
    try {
      result = await consume(redisClient, key, limit, windowSeconds);
    } catch (err) {
      // Don't take the API down when Redis is the one degraded — the rate
      // limit is defense-in-depth, not authoritative. Log + fail open.
      console.error(
        `[rate-limit] Redis error for ${key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await next();
      return;
    }

    // Standard rate-limit headers (draft RFC). Clients use these to back off.
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(result.resetSeconds));

    if (!result.allowed) {
      c.header("Retry-After", String(result.resetSeconds));
      throw new RateLimitedError(
        `Rate limit exceeded for ${scope}. Try again in ${result.resetSeconds}s.`,
        { scope, limit, windowSeconds, retryAfterSeconds: result.resetSeconds },
      );
    }

    await next();
  };
}
