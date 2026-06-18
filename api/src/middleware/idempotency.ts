import type { Context, Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { Redis } from "ioredis";
import redis from "../redis";
import { ValidationError } from "../errors";
import type { AppEnv } from "../types";

// Idempotency-Key middleware for non-idempotent mutation endpoints.
//
// Design: header is optional — if absent the middleware is a transparent
// passthrough. If present the key is scoped per-user + method + path to
// prevent cross-user replay and cross-endpoint collisions.
//
// Stored payload in Redis (24h TTL):
//   { status: number, body: string, contentType: string }
//
// On Redis failure: fail-open (invoke handler normally). The idempotency
// guarantee degrades to best-effort rather than taking the API down.

const KEY_MIN = 16;
const KEY_MAX = 128;
const TTL_SECONDS = 86_400; // 24 h
const REPLAY_HEADER = "X-Idempotent-Replay";

interface StoredResponse {
  status: number;
  body: string;
  contentType: string;
}

export interface IdempotencyOptions {
  /** Inject a Redis client for tests. */
  redisClient?: Redis;
}

function redisKey(userId: string, method: string, path: string, key: string): string {
  return `idem:${userId}:${method}:${path}:${key}`;
}

/**
 * Build an idempotency middleware. Attach route-scoped with `.use()` on
 * specific POST routes — do NOT mount globally.
 *
 * Requires authMiddleware to have already set `userId` on the context.
 */
export function idempotency(options: IdempotencyOptions = {}) {
  const client: Redis = options.redisClient ?? redis;

  return async (c: Context<AppEnv>, next: Next) => {
    const idempKey = c.req.header("Idempotency-Key");

    // No header → transparent passthrough; idempotency is optional.
    if (!idempKey) {
      await next();
      return;
    }

    if (idempKey.length < KEY_MIN || idempKey.length > KEY_MAX) {
      throw new ValidationError(
        `Idempotency-Key must be ${KEY_MIN}–${KEY_MAX} characters`,
      );
    }

    const userId = c.get("userId");
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const rKey = redisKey(userId, method, path, idempKey);

    let stored: StoredResponse | null = null;
    try {
      const raw = await client.get(rKey);
      if (raw) {
        stored = JSON.parse(raw) as StoredResponse;
      }
    } catch (err) {
      // Fail-open: Redis unavailable — process request normally.
      console.error(
        `[idempotency] Redis GET error for key ${rKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await next();
      return;
    }

    if (stored) {
      // Replay the cached response without touching the handler.
      return c.newResponse(stored.body, stored.status as StatusCode, {
        [REPLAY_HEADER]: "true",
        "Content-Type": stored.contentType,
      });
    }

    // First call: run the handler and capture the response.
    await next();

    // Capture after handler completes.
    const res = c.res;
    if (!res) return;

    const contentType = res.headers.get("content-type") ?? "application/json";
    let body = "";
    try {
      body = await res.clone().text();
    } catch {
      // If we can't clone the body, don't cache — response was already sent.
      return;
    }

    const payload: StoredResponse = {
      status: res.status,
      body,
      contentType,
    };

    try {
      await client.set(rKey, JSON.stringify(payload), "EX", TTL_SECONDS);
    } catch (err) {
      // Fail-open: cache miss is safe; the response was already sent.
      console.error(
        `[idempotency] Redis SET error for key ${rKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}
