import { describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { Cache, buildKey } from "./cache";

// Minimal in-memory stand-in for the subset of ioredis the Cache uses.
function fakeRedis() {
  const store = new Map<string, string>();
  const calls = { get: 0, set: 0 };
  const client = {
    async get(key: string) {
      calls.get++;
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, val: string) {
      calls.set++;
      store.set(key, val);
      return "OK";
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
  } as unknown as Redis;
  return { client, store, calls };
}

describe("Cache", () => {
  test("buildKey namespaces and joins parts", () => {
    expect(buildKey("resume:tailored", ["u1", "j2", 3])).toBe(
      "resume:tailored:u1:j2:3",
    );
  });

  test("get returns null on miss", async () => {
    const { client } = fakeRedis();
    const cache = new Cache(client);
    expect(await cache.get("jd:parsed", ["x"])).toBeNull();
  });

  test("set then get round-trips a value", async () => {
    const { client } = fakeRedis();
    const cache = new Cache(client);
    await cache.set("jd:parsed", ["x"], { skills: ["go", "ts"] });
    expect(await cache.get<{ skills: string[] }>("jd:parsed", ["x"])).toEqual({
      skills: ["go", "ts"],
    });
  });

  test("get treats corrupt JSON as a miss", async () => {
    const { client, store } = fakeRedis();
    store.set(buildKey("jd:parsed", ["x"]), "{not valid json");
    const cache = new Cache(client);
    expect(await cache.get("jd:parsed", ["x"])).toBeNull();
  });

  test("getOrSet runs loader once on miss then serves from cache", async () => {
    const { client, calls } = fakeRedis();
    const cache = new Cache(client);
    let loaderRuns = 0;
    const loader = async () => {
      loaderRuns++;
      return { value: 42 };
    };

    const first = await cache.getOrSet("match:score", ["a", "b"], loader);
    const second = await cache.getOrSet("match:score", ["a", "b"], loader);

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(loaderRuns).toBe(1);
    expect(calls.set).toBe(1);
  });

  test("del removes a cached entry", async () => {
    const { client } = fakeRedis();
    const cache = new Cache(client);
    await cache.set("trends:today", ["2026-06-17"], { jobs: 10 });
    await cache.del("trends:today", ["2026-06-17"]);
    expect(await cache.get("trends:today", ["2026-06-17"])).toBeNull();
  });
});
