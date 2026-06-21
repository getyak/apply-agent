import type { Redis } from "ioredis";
import redis from "./redis";

// Thin caching layer over Redis: namespaced keys, explicit TTLs, and a
// getOrSet pattern with JSON (de)serialization. Cache misses and corrupt
// entries degrade gracefully — the source-of-truth loader still runs.

/** Namespaces keep unrelated cache entries from colliding and ease bulk eviction. */
export type CacheNamespace =
  | "resume:tailored"
  | "jd:parsed"
  | "match:score"
  | "trends:today";

/** Default TTLs (seconds) per namespace; callers may override per call. */
const DEFAULT_TTL: Record<CacheNamespace, number> = {
  "resume:tailored": 7 * 24 * 60 * 60, // 7 days
  "jd:parsed": 24 * 60 * 60, // 1 day
  "match:score": 60 * 60, // 1 hour
  "trends:today": 60 * 60, // 1 hour
};

function buildKey(ns: CacheNamespace, parts: (string | number)[]): string {
  return [ns, ...parts.map(String)].join(":");
}

export class Cache {
  constructor(private readonly client: Redis = redis) {}

  async get<T>(ns: CacheNamespace, parts: (string | number)[]): Promise<T | null> {
    const raw = await this.client.get(buildKey(ns, parts));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt entry — treat as a miss rather than crash the caller.
      return null;
    }
  }

  async set<T>(
    ns: CacheNamespace,
    parts: (string | number)[],
    value: T,
    ttlSeconds: number = DEFAULT_TTL[ns],
  ): Promise<void> {
    await this.client.set(
      buildKey(ns, parts),
      JSON.stringify(value),
      "EX",
      ttlSeconds,
    );
  }

  async del(ns: CacheNamespace, parts: (string | number)[]): Promise<void> {
    await this.client.del(buildKey(ns, parts));
  }

  /**
   * Return the cached value if present, otherwise run `loader`, cache its
   * result, and return it. `loader` runs at most once per miss.
   *
   * CACHE_S3 (round-19): the round-19 audit found that when `loader`
   * throws (an LLM 500, a transient PG error, an upstream timeout)
   * we wrote nothing to the cache, so the next request retried
   * immediately — a single failing key under load amplified into a
   * stampede that hammered the upstream as fast as the API could
   * accept new requests. Write a short-lived error sentinel into the
   * cache for `errorTtlSeconds` (default 30 s, gated by NEGATIVE_TTL)
   * so a transient outage doesn't keep replaying. On the next call we
   * spot the sentinel and re-throw a recognisable `CachedFailure`
   * without touching the upstream, then the sentinel expires and a
   * single retry attempt is allowed through.
   */
  async getOrSet<T>(
    ns: CacheNamespace,
    parts: (string | number)[],
    loader: () => Promise<T>,
    ttlSeconds: number = DEFAULT_TTL[ns],
    errorTtlSeconds: number = NEGATIVE_TTL,
  ): Promise<T> {
    const hit = await this.get<unknown>(ns, parts);
    if (hit !== null) {
      if (isErrorSentinel(hit)) {
        // Last loader attempt failed within `errorTtlSeconds`. Surface
        // a recognisable error so the caller can map it to the same
        // upstream status without paying for another fetch.
        throw new CachedFailure(hit.__cached_error__);
      }
      return hit as T;
    }
    try {
      const value = await loader();
      await this.set(ns, parts, value, ttlSeconds);
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.set(
        ns,
        parts,
        { __cached_error__: message } satisfies ErrorSentinel,
        errorTtlSeconds,
      );
      throw err;
    }
  }
}

// CACHE_S3 (round-19): a short TTL for the negative sentinel — long
// enough to break a tight stampede loop, short enough that a real
// outage recovery is visible to users within a single page reload.
const NEGATIVE_TTL = 30; // seconds

interface ErrorSentinel {
  __cached_error__: string;
}

function isErrorSentinel(value: unknown): value is ErrorSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    "__cached_error__" in value &&
    typeof (value as ErrorSentinel).__cached_error__ === "string"
  );
}

export class CachedFailure extends Error {
  constructor(message: string) {
    super(`cached upstream failure: ${message}`);
    this.name = "CachedFailure";
  }
}

export const cache = new Cache();
export { buildKey, DEFAULT_TTL };
