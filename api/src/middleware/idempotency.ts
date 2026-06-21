import type { Context, Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { Redis } from "ioredis";
import redis from "../redis";
import { ConflictError, ValidationError } from "../errors";
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
  // IDEM3 (round-9): hex sha256 of the original request body, stored
  // alongside the response so replays with a *different* request body
  // get a 409 instead of silently returning the prior response. Old
  // cache entries written before round-9 have no hash; we treat that
  // as "back-compat replay" and skip the comparison.
  requestHash?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// IDEM_N1 / IDEM_N2 (round-17): the round-9 hash compared raw body
// strings, which meant a client that re-sent the same logical request
// with a different object-key order (e.g. `{"a":1,"b":2}` vs
// `{"b":2,"a":1}`) got a spurious 409 ConflictError — JS objects don't
// guarantee key order, and a number of mainstream HTTP libraries
// reorder keys on serialize. Canonicalize JSON bodies first: parse,
// recursively sort object keys, then re-stringify. Arrays stay
// order-sensitive because order is semantically meaningful in our
// payloads (e.g. `formFields` reflects on-page order). Non-JSON
// bodies (form-encoded, binary) fall back to the raw string so
// behaviour is unchanged for those.
function canonicalizeBody(raw: string): string {
  if (raw.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  return JSON.stringify(parsed, replacerSortingKeys);
}

// JSON.stringify replacer that returns a key-sorted *plain object* for
// non-null objects (arrays pass through unchanged). The recursive
// behaviour comes for free: stringify walks the returned value and
// re-invokes the replacer on each nested key/value pair.
function replacerSortingKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
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

    // IDEM3 (round-9): hash the *current* request body so we can compare
    // against whatever we stored on the first call. Reading the body
    // here is safe because the handler hasn't run yet and Hono lets us
    // clone the underlying Request. Bodyless requests (GET, DELETE) get
    // an empty-string hash, which still works as a stable key.
    let currentBody = "";
    try {
      currentBody = await c.req.raw.clone().text();
    } catch {
      currentBody = "";
    }
    // IDEM_N1 / IDEM_N2 (round-17): canonicalize JSON bodies so a
    // re-serialization with different object-key order doesn't trip the
    // round-9 body-mismatch guard.
    const currentHash = await sha256Hex(canonicalizeBody(currentBody));

    if (stored) {
      // IDEM3 (round-9): the round-9 audit showed that without a body
      // comparison, a client that reuses an Idempotency-Key but mutates
      // the request body would silently get the *first* call's
      // response, with no signal that the new body was ignored. Reject
      // with 409 instead. Old entries (no requestHash, written before
      // round-9) replay unchanged to avoid breaking in-flight keys.
      if (stored.requestHash && stored.requestHash !== currentHash) {
        throw new ConflictError(
          "Idempotency-Key reused with a different request body. Pick a new key for a different payload.",
        );
      }
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
      requestHash: currentHash,
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
