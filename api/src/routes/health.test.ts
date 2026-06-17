import { describe, expect, it } from "bun:test";
import { buildReadinessReport, createHealthRoutes } from "./health";

const okPing = () => Promise.resolve();
const failPing = (msg: string) => () => Promise.reject(new Error(msg));

describe("buildReadinessReport", () => {
  it("reports ok when PG and Redis pings succeed", async () => {
    const report = await buildReadinessReport(
      {
        pgPing: okPing,
        redisPing: okPing,
        storageAvailable: () => true,
      },
      (() => {
        let t = 1000;
        return () => (t += 5);
      })(),
      () => "2026-06-17T00:00:00.000Z",
    );
    expect(report.status).toBe("ok");
    expect(report.checks.postgres.status).toBe("up");
    expect(report.checks.redis.status).toBe("up");
    expect(report.checks.storage.status).toBe("up");
    expect(report.checks.postgres.latencyMs).toBeGreaterThan(0);
  });

  it("marks storage as unconfigured (not down) when creds absent", async () => {
    const report = await buildReadinessReport({
      pgPing: okPing,
      redisPing: okPing,
      storageAvailable: () => false,
    });
    expect(report.status).toBe("ok");
    expect(report.checks.storage.status).toBe("unconfigured");
  });

  it("flips to degraded when Postgres ping fails", async () => {
    const report = await buildReadinessReport({
      pgPing: failPing("ECONNREFUSED"),
      redisPing: okPing,
      storageAvailable: () => true,
    });
    expect(report.status).toBe("degraded");
    expect(report.checks.postgres.status).toBe("down");
    expect(report.checks.postgres.reason).toContain("ECONNREFUSED");
    expect(report.checks.redis.status).toBe("up");
  });

  it("flips to degraded when Redis ping fails", async () => {
    const report = await buildReadinessReport({
      pgPing: okPing,
      redisPing: failPing("redis: connection lost"),
      storageAvailable: () => true,
    });
    expect(report.status).toBe("degraded");
    expect(report.checks.redis.status).toBe("down");
  });
});

describe("createHealthRoutes", () => {
  it("/health is always 200 regardless of downstream state", async () => {
    const app = createHealthRoutes({
      pgPing: failPing("down"),
      redisPing: failPing("down"),
      storageAvailable: () => false,
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("/ready returns 200 when all required deps are up", async () => {
    const app = createHealthRoutes({
      pgPing: okPing,
      redisPing: okPing,
      storageAvailable: () => true,
    });
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("/ready returns 503 when a required dep is down", async () => {
    const app = createHealthRoutes({
      pgPing: failPing("pg down"),
      redisPing: okPing,
      storageAvailable: () => true,
    });
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, { status: string }> };
    expect(body.status).toBe("degraded");
    expect(body.checks.postgres.status).toBe("down");
  });
});
