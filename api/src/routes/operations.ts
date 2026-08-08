import { Hono } from "hono";
import { z } from "zod";
import { query } from "../db";
import { NotFoundError } from "../errors";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

type OperationRow = {
  id: string;
  status: string;
  result: unknown;
  error_class: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  reconcile_count: number;
  next_attempt_at: string | Date | null;
};

function recoveryAction(row: OperationRow): string {
  if (row.status === "succeeded") return "none";
  if (row.status === "reconciling") return "reconcile";
  if (row.status === "waiting_retry") return "retry";
  if (row.status === "running" || row.status === "pending") return "poll";
  if (row.status === "waiting_user") {
    if (row.error_class === "auth") return "reauth";
    if (row.error_class === "validation") return "fix_input";
    return "human_review";
  }
  return "stop";
}

function maxAttempts(row: OperationRow): number | null {
  if (row.error_code === "DB_CONTENTION") return 5;
  if (row.error_class === "transient" || row.error_class === "throttled") return 3;
  return null;
}

/**
 * Owner-scoped status lookup for browser/UI consumers. Mutation execution and
 * reconciliation remain in the Python harness; the Hono layer only reads the
 * shared PostgreSQL fact ledger.
 */
app.get("/:id", async (c) => {
  const operationId = z.string().uuid().safeParse(c.req.param("id"));
  if (!operationId.success) {
    throw new NotFoundError("Operation not found");
  }
  const result = await query<OperationRow>(
    `SELECT id, status, result, error_class, error_code, error_message,
            attempt_count, reconcile_count, next_attempt_at
       FROM agent_operations
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [operationId.data, c.get("userId")],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Operation not found");

  return c.json({
    operation_id: row.id,
    status: row.status,
    result: row.result,
    error: row.error_class
      ? {
          code: row.error_code,
          class: row.error_class,
          message: row.error_message,
        }
      : null,
    recovery: {
      action: recoveryAction(row),
      not_before: row.next_attempt_at
        ? new Date(row.next_attempt_at).toISOString()
        : null,
      attempt: row.attempt_count,
      max_attempts: maxAttempts(row),
      reconcile_attempt: row.reconcile_count,
      max_reconcile_attempts: 3,
    },
  });
});

export default app;
