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
   */
  async getOrSet<T>(
    ns: CacheNamespace,
    parts: (string | number)[],
    loader: () => Promise<T>,
    ttlSeconds: number = DEFAULT_TTL[ns],
  ): Promise<T> {
    const hit = await this.get<T>(ns, parts);
    if (hit !== null) return hit;
    const value = await loader();
    await this.set(ns, parts, value, ttlSeconds);
    return value;
  }
}

export const cache = new Cache();
export { buildKey, DEFAULT_TTL };
