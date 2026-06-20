import pg from "pg";
import { config } from "./config";

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  // DB-bundle (round-11): the round-11 audit found we had no
  // connectionTimeout / statement_timeout, so a slow PG startup or a
  // runaway query could pin a connection until the OS TCP timer fired
  // (minutes). 5 s for the dial bound covers any honest interactive
  // path; 30 s on the server side bounds the longest pre-stream
  // synchronous request the gateway makes today.
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
});

// DB-bundle (round-11): pg.Pool emits an `'error'` event when an idle
// background connection dies (PG restart, transient network). Without
// a listener Node crashes the whole process on the next tick; catching
// it lets `pool` recover transparently by handing out a fresh
// connection on the next .query() call.
pool.on("error", (err) => {
  console.error(`[db] idle client error: ${err.message}`);
});

let shutdownInstalled = false;
/**
 * DB-bundle (round-11): install SIGTERM / SIGINT handlers that drain
 * the pool on graceful shutdown. Without this, a rolling deploy kills
 * the process the instant the OS sends SIGTERM, leaving any in-flight
 * `query()` callers with a `connection reset by peer` error.
 *
 * Idempotent: subsequent calls are no-ops so test harnesses and
 * scripts can safely import it.
 */
export function installDbShutdownHandlers(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const drain = async (signal: string) => {
    console.log(`[db] received ${signal}, draining pool…`);
    try {
      await pool.end();
      console.log("[db] pool drained");
    } catch (err) {
      console.error(
        `[db] error during pool drain: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  process.once("SIGTERM", () => void drain("SIGTERM"));
  process.once("SIGINT", () => void drain("SIGINT"));
}

/**
 * DB-bundle (round-11): probe PG once at boot so a misconfigured
 * DATABASE_URL fails fast (the process logs and continues) instead of
 * letting the readiness probe stay green until the first 5xx. Caller
 * (api/src/index.ts) awaits this before the listener accepts requests.
 *
 * We deliberately don't process.exit on failure — the readiness probe
 * already drives the rollout decision, and the gateway has been
 * useful in dev when PG is briefly offline. We just log loud enough
 * that nobody can miss the missed connection in tests / CI.
 */
export async function pingDbAtBoot(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    console.warn(
      `[db] boot ping failed (will keep serving — readiness probe will reflect this): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Run `cb` inside a single transaction on one pooled client.
 * Commits on success, rolls back on any thrown error, and always releases the
 * client. Use for multi-step writes (session create, application submit, sagas)
 * so a mid-sequence failure never leaves orphan rows.
 */
export async function withTransaction<T>(
  cb: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await cb(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures (e.g. connection already dropped); surface
      // the original error to the caller below.
    }
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
