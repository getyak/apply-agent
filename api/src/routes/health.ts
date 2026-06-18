import { Hono } from "hono";
import type { AppEnv } from "../types";
import { config } from "../config";
import { query } from "../db";
import redis from "../redis";
import { storage } from "../storage";

// Liveness vs readiness, deliberately separated:
//   /health  — process is up and answering. Used by orchestrator liveness
//              probes; MUST stay 200 even when downstreams are degraded so the
//              orchestrator doesn't restart a healthy node while Redis recovers.
//   /ready   — every downstream the API needs to serve traffic is reachable.
//              Used by load-balancer readiness probes; returns 503 with a
//              per-dependency breakdown so a single dead datastore takes the
//              node out of rotation without killing it.

export interface DependencyCheck {
  /** "up" / "down" / "unconfigured" — unconfigured is a soft state, not a failure. */
  status: "up" | "down" | "unconfigured";
  /** Short reason on "down" so operators can grep alerts without opening a UI. */
  reason?: string;
  /** Round-trip in ms; useful to surface degradation before it becomes an outage. */
  latencyMs?: number;
}

export interface ReadinessReport {
  status: "ok" | "degraded";
  timestamp: string;
  checks: {
    postgres: DependencyCheck;
    redis: DependencyCheck;
    storage: DependencyCheck;
    /** Python LangGraph host. Optional dep — `down` doesn't flip readiness
     *  to degraded by itself, because /api/ask gracefully 503s with a
     *  user-facing hint and every non-LLM route keeps working. */
    agents: DependencyCheck;
  };
}

interface Deps {
  pgPing: () => Promise<void>;
  redisPing: () => Promise<void>;
  storageAvailable: () => boolean;
  /** Probes the Python LangGraph host. Returns void on success; throws on
   *  unreachable/timeout/non-2xx. Test seam — production wiring lives in
   *  defaultDeps. */
  agentPing: () => Promise<void>;
}

async function timed(
  fn: () => Promise<void>,
  now: () => number = Date.now,
): Promise<DependencyCheck> {
  const start = now();
  try {
    await fn();
    return { status: "up", latencyMs: now() - start };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "down", reason };
  }
}

/** Build the readiness report. Exposed for unit tests so deps can be stubbed. */
export async function buildReadinessReport(
  deps: Deps,
  now: () => number = Date.now,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<ReadinessReport> {
  const [postgres, redisCheck, agentsCheck] = await Promise.all([
    timed(deps.pgPing, now),
    timed(deps.redisPing, now),
    timed(deps.agentPing, now),
  ]);

  // Object storage is optional in dev/CI (no S3 creds). "unconfigured" is not
  // a failure — file-upload routes already degrade gracefully — so it doesn't
  // flip readiness to degraded by itself.
  const storageCheck: DependencyCheck = deps.storageAvailable()
    ? { status: "up" }
    : { status: "unconfigured" };

  // Postgres + Redis are required; storage and agents are optional. The
  // agents host can be missing in dev (no Python process running) — ask.ts
  // returns a 503 with a human-readable code in that case, but routes that
  // don't touch the LLM keep serving, so we don't let it flip readiness.
  const status: ReadinessReport["status"] =
    postgres.status === "down" || redisCheck.status === "down"
      ? "degraded"
      : "ok";

  return {
    status,
    timestamp: nowIso(),
    checks: {
      postgres,
      redis: redisCheck,
      storage: storageCheck,
      agents: agentsCheck,
    },
  };
}

/** 1.5 s — well under the LB readiness probe interval. Slow agent host
 *  shouldn't make the API look down by tying up the probe. */
const AGENT_PING_TIMEOUT_MS = 1500;

async function pingAgentHost(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_PING_TIMEOUT_MS);
  try {
    const base = config.AGENT_BASE_URL.replace(/\/$/, "");
    const res = await fetch(`${base}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`agent host returned ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const defaultDeps: Deps = {
  pgPing: async () => {
    await query("SELECT 1");
  },
  redisPing: async () => {
    await redis.ping();
  },
  storageAvailable: () => storage.available,
  agentPing: pingAgentHost,
};

/**
 * Wire `/health` and `/ready`. The `deps` override is for tests; production
 * code uses the live PG / Redis / storage clients.
 */
export function createHealthRoutes(deps: Deps = defaultDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString() }),
  );

  app.get("/ready", async (c) => {
    const report = await buildReadinessReport(deps);
    // 503 lets LB pull this node out; 200 keeps it in rotation.
    return c.json(report, report.status === "ok" ? 200 : 503);
  });

  return app;
}

export default createHealthRoutes();
