import pg from "pg";
import { config } from "./config";

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

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
