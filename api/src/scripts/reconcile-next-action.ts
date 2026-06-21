/**
 * Reconcile script: persist `next_action` / `next_action_due` columns
 * on `application_drafts` so the kanban + today queue can sort on
 * indexed DB rows instead of recomputing per-request.
 *
 * Until a real cron / worker pool ships, this is meant to be invoked
 * manually:
 *
 *   bun run api/src/scripts/reconcile-next-action.ts
 *
 * The same script is wired up for the future cron — the entry point
 * stays the same so swapping the trigger doesn't change behaviour.
 *
 * Idempotency: we SELECT every row, compute the desired
 * (next_action, next_action_due) via the same `deriveNextAction`
 * helper the API uses on-the-fly, and ONLY UPDATE rows where the
 * persisted value drifted from the derived one. A no-drift run logs
 * `0 updated` and exits 0 — safe to run on a tight schedule.
 *
 * Limits:
 *   - Page through 500 rows at a time so a 50k-row table doesn't load
 *     into memory.
 *   - --dry-run prints the planned UPDATEs without executing them; CI
 *     uses this for a sanity check before the cron lands.
 *   - --user <uuid> scopes to one user, for debugging.
 *
 * Exit codes:
 *   0  — success (whether or not any rows were updated)
 *   1  — DB unreachable or fatal error during iteration
 */

import { query } from "../db";
import { deriveNextAction } from "../routes/applications";

interface CliFlags {
  dryRun: boolean;
  userId?: string;
  pageSize: number;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { dryRun: false, pageSize: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--user" && argv[i + 1]) {
      out.userId = argv[i + 1];
      i++;
    } else if (a === "--page-size" && argv[i + 1]) {
      out.pageSize = Math.max(1, Math.min(5000, Number.parseInt(argv[i + 1], 10) || 500));
      i++;
    }
  }
  return out;
}

interface DbRow {
  id: string;
  status: string | null;
  submitted_at: string | null;
  interview_date: string | null;
  outcome: string | null;
  next_action: string | null;
  next_action_due: string | null;
}

function normaliseDue(due: string | null): string | null {
  // PG returns TIMESTAMPTZ as an ISO string; deriveNextAction's input
  // is the same type, but the *output* is also ISO. We normalise both
  // to millisecond-truncated UTC so the equality test below doesn't
  // mistake "same moment, different fractional second" for drift.
  if (!due) return null;
  const t = new Date(due).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

interface ReconcileSummary {
  scanned: number;
  updated: number;
  skipped: number;
  pages: number;
}

async function reconcile(flags: CliFlags): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { scanned: 0, updated: 0, skipped: 0, pages: 0 };

  // Page by (created_at, id) to make iteration deterministic even when
  // rows churn between pages. `id` is the tiebreaker for rows sharing
  // a created_at.
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  // `1=1` keeps the parameter index logic stable regardless of which
  // filters are active. We append clauses as we go.
  while (true) {
    const params: unknown[] = [];
    const where: string[] = ["1=1"];
    if (flags.userId) {
      params.push(flags.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (cursorCreatedAt && cursorId) {
      params.push(cursorCreatedAt, cursorId);
      where.push(
        `(created_at, id) > ($${params.length - 1}, $${params.length})`,
      );
    }
    params.push(flags.pageSize);
    const limitIdx = params.length;

    const rows = await query<DbRow>(
      `SELECT id, status, submitted_at, interview_date, outcome,
              next_action, next_action_due
         FROM application_drafts
        WHERE ${where.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        LIMIT $${limitIdx}`,
      params,
    );

    if (rows.rows.length === 0) break;
    summary.pages++;

    for (const row of rows.rows) {
      summary.scanned++;
      const derived = deriveNextAction(row);
      const want_action = derived.next_action_derived;
      const want_due = derived.next_action_due_derived;
      const have_action = row.next_action;
      const have_due = normaliseDue(row.next_action_due);

      if (have_action === want_action && have_due === want_due) {
        summary.skipped++;
        continue;
      }

      summary.updated++;
      if (flags.dryRun) {
        console.log(
          JSON.stringify({
            dry_run: true,
            id: row.id,
            from: { next_action: have_action, next_action_due: have_due },
            to: { next_action: want_action, next_action_due: want_due },
          }),
        );
      } else {
        await query(
          `UPDATE application_drafts
              SET next_action = $1,
                  next_action_due = $2
            WHERE id = $3`,
          [want_action, want_due, row.id],
        );
      }
    }

    // Advance the cursor to the last row of this page. We fetch
    // created_at explicitly in a second query because the row we read
    // through `SELECT id, status, …` already includes it implicitly
    // via the ORDER BY but isn't projected into the result set; the
    // simplest fix is to ask PG for the cursor pair directly.
    const last = rows.rows[rows.rows.length - 1];
    const ts = await query<{ created_at: string }>(
      `SELECT created_at FROM application_drafts WHERE id = $1`,
      [last.id],
    );
    cursorCreatedAt = ts.rows[0]?.created_at ?? null;
    cursorId = last.id;
    if (rows.rows.length < flags.pageSize) break;
  }

  return summary;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const t0 = Date.now();
  let summary: ReconcileSummary;
  try {
    summary = await reconcile(flags);
  } catch (err) {
    console.error(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ok: true,
      dry_run: flags.dryRun,
      scoped_to_user: flags.userId ?? null,
      ...summary,
      elapsed_ms: Date.now() - t0,
    }),
  );
}

// Run only when invoked directly. Imported (e.g. by future job
// runners) doesn't auto-execute.
if (import.meta.main) {
  void main();
}

export { reconcile, parseFlags };
