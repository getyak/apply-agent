import { query as dbQuery } from "./db";
import { NotFoundError } from "./errors";

// Authorization helper (API-007). Every per-resource route must confirm the
// authenticated user owns the row before reading or mutating it. Routes do this
// ad-hoc today (`WHERE id=$1 AND user_id=$2` + a hand-written 404), which is
// easy to forget on a new endpoint. This centralizes the ownership check so a
// missed guard is a missing function call, not a silent cross-user leak.
//
// We surface NOT_FOUND (not FORBIDDEN) for a row owned by someone else: leaking
// "this id exists but isn't yours" is an enumeration vector. Same response for
// "absent" and "not yours".

/** Tables that carry a `user_id` ownership column. */
export type OwnedTable =
  | "resumes"
  | "application_drafts"
  | "interview_sessions"
  | "user_files";

/** Minimal query surface, injectable so the guard is unit-testable without PG. */
export type QueryFn = (
  text: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * Throw NotFoundError unless `userId` owns row `id` in `table`.
 * Returns the row (selected columns) so callers can reuse it without a second
 * round-trip.
 *
 *   const resume = await requireOwnership("resumes", id, userId, "content, version");
 */
export async function requireOwnership(
  table: OwnedTable,
  id: string,
  userId: string,
  columns = "*",
  q: QueryFn = dbQuery as unknown as QueryFn,
): Promise<Record<string, unknown>> {
  const row = await fetchOwned(table, id, userId, columns, q);
  if (!row) {
    throw new NotFoundError(`${humanName(table)} not found`);
  }
  return row;
}

/**
 * Like requireOwnership but returns null instead of throwing — for callers that
 * want to branch (e.g. upsert) rather than 404.
 */
export async function fetchOwned(
  table: OwnedTable,
  id: string,
  userId: string,
  columns = "*",
  q: QueryFn = dbQuery as unknown as QueryFn,
): Promise<Record<string, unknown> | null> {
  // `table` and `columns` are developer-supplied constants, never user input —
  // parameterizing identifiers isn't possible in SQL, so they must stay
  // non-interpolated-from-request. id/userId are always bound parameters.
  const result = await q(
    `SELECT ${columns} FROM ${table} WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}

/** "application_drafts" → "Application", for human-readable error messages. */
function humanName(table: OwnedTable): string {
  const map: Record<OwnedTable, string> = {
    resumes: "Resume",
    application_drafts: "Application",
    interview_sessions: "Interview session",
    user_files: "File",
  };
  return map[table];
}
