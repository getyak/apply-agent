import { Hono } from "hono";
import { config } from "../config";
import { query } from "../db";
import { ConflictError, UpstreamError } from "../errors";
import { authMiddleware } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";
import { validateBody } from "../middleware/validate";
import {
  PrepareApplicationSchema,
  PrepareFromJDSchema,
  UpdateApplicationSchema,
  type PrepareApplication,
  type PrepareFromJD,
  type UpdateApplication,
} from "../schemas";
import { requireOwnership } from "../ownership";
import { parsePagination, paginated } from "../pagination";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

// Route-scoped idempotency: preparing a draft creates a DB row — duplicate
// requests with the same Idempotency-Key replay the first response instead.
app.post("/prepare", idempotency(), validateBody(PrepareApplicationSchema), async (c) => {
  const userId = c.get("userId");
  const { jobId, resumeId, coverLetter, formAnswers } = c.get(
    "validatedBody",
  ) as PrepareApplication;

  const result = await query(
    `INSERT INTO application_drafts (user_id, job_id, resume_version_id, cover_letter, form_answers, status)
     VALUES ($1, $2, $3, $4, $5, 'draft')
     RETURNING *`,
    [userId, jobId, resumeId || null, coverLetter || null, formAnswers ? JSON.stringify(formAnswers) : null],
  );
  return c.json({ application: result.rows[0] }, 201);
});

// T3b · prepare-from-jd
// Drives the delivery loop end-to-end. Forwards to the Python agent layer's
// /applications/prepare endpoint (delivery-loop-plan.md § 3 T3), which runs
// the parse_jd → customize → cover → form saga and TTAR measurement. The TS
// gateway only does what only it can do: look up the user's base résumé
// from the canonical PG row and forward the auth-resolved user id.
app.post(
  "/prepare-from-jd",
  idempotency(),
  validateBody(PrepareFromJDSchema),
  async (c) => {
    const userId = c.get("userId");
    const { jdUrl, formFields, applicationId } = c.get(
      "validatedBody",
    ) as PrepareFromJD;

    // 1. Find user's current base résumé.
    const baseResume = await query<{
      id: string;
      version: number;
      content: unknown;
    }>(
      `SELECT id, version, content
         FROM resumes
        WHERE user_id = $1 AND is_base = TRUE
        ORDER BY version DESC
        LIMIT 1`,
      [userId],
    );
    if (baseResume.rows.length === 0) {
      throw new ConflictError(
        "Upload or generate a base résumé before preparing an application.",
      );
    }
    const base = baseResume.rows[0]!;
    const content =
      typeof base.content === "string" ? JSON.parse(base.content) : base.content;

    // 2. Forward to the Python agent layer.
    const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/applications/prepare`;
    const agentResp = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-user-id": userId,
      },
      body: JSON.stringify({
        jd_url: jdUrl,
        base_resume_id: base.id,
        base_resume_content: content,
        base_resume_version: base.version,
        form_fields: formFields ?? [],
        application_id: applicationId,
      }),
    });
    if (!agentResp.ok) {
      const body = await agentResp.text();
      throw new UpstreamError(
        `agent /applications/prepare returned ${agentResp.status}`,
        body.slice(0, 500),
      );
    }
    const data = (await agentResp.json()) as Record<string, unknown>;
    return c.json(data);
  },
);

app.get("/", async (c) => {
  const userId = c.get("userId");
  const status = c.req.query("status");
  const { limit, offset, order } = parsePagination(c.req.query(), {
    sortable: ["created_at"],
    defaultLimit: 20,
  });

  const filter: string[] = ["ad.user_id = $1"];
  const params: unknown[] = [userId];
  if (status) {
    params.push(status);
    filter.push(`ad.status = $${params.length}`);
  }
  const where = filter.join(" AND ");

  const totalResult = await query(
    `SELECT COUNT(*)::int AS total FROM application_drafts ad WHERE ${where}`,
    params,
  );
  const total = totalResult.rows[0].total as number;

  const result = await query(
    `SELECT ad.*, j.company, j.role_title, j.url
     FROM application_drafts ad
     LEFT JOIN jobs j ON ad.job_id = j.id
     WHERE ${where}
     ORDER BY ad.created_at ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return c.json(paginated(result.rows.map(withDerived), total, { limit, offset }));
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id")!;
  await requireOwnership("application_drafts", id, userId, "id"); // 404 if not owned
  const result = await query(
    `SELECT ad.*, j.company, j.role_title, j.url, j.jd_text, j.parsed
     FROM application_drafts ad
     LEFT JOIN jobs j ON ad.job_id = j.id
     WHERE ad.id = $1 AND ad.user_id = $2`,
    [id, userId],
  );
  return c.json({ application: withDerived(result.rows[0]) });
});

app.patch("/:id", validateBody(UpdateApplicationSchema), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id")!;
  const body = c.get("validatedBody") as UpdateApplication;
  await requireOwnership("application_drafts", id, userId, "id"); // 404 if not owned

  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (body.status !== undefined) {
    updates.push(`status = $${idx++}`);
    params.push(body.status);
  }
  if (body.coverLetter !== undefined) {
    updates.push(`cover_letter = $${idx++}`);
    params.push(body.coverLetter);
  }
  if (body.formAnswers !== undefined) {
    updates.push(`form_answers = $${idx++}`);
    params.push(JSON.stringify(body.formAnswers));
  }
  if (body.outcome !== undefined) {
    updates.push(`outcome = $${idx++}`);
    params.push(body.outcome);
  }
  if (body.status === "submitted") {
    updates.push(`submitted_at = NOW()`);
    updates.push(`submitted_via = $${idx++}`);
    params.push(body.submittedVia || "client_extension");
  }

  params.push(id, userId);
  const result = await query(
    `UPDATE application_drafts SET ${updates.join(", ")}
     WHERE id = $${idx++} AND user_id = $${idx}
     RETURNING *`,
    params,
  );
  return c.json({ application: withDerived(result.rows[0]) });
});

// ─── Next-action derivation (P3.2) ─────────────────────────────────────
//
// Until the reconcile cron lands (Phase 3 follow-up) we derive a
// next_action client-side-of-the-API from the row's existing state. The
// real persisted column stays NULL until cron writes it; this derived
// pair is added alongside under *_derived keys so the front-end can
// prefer DB values when present and fall back to live derivation.

type DerivedNextAction =
  | "prep"
  | "submit"
  | "follow_up"
  | "interview"
  | "close_loop"
  | null;

interface DerivedPair {
  next_action_derived: DerivedNextAction;
  next_action_due_derived: string | null;
}

function deriveNextAction(row: {
  status?: string | null;
  submitted_at?: string | Date | null;
  interview_date?: string | Date | null;
  outcome?: string | null;
}): DerivedPair {
  const now = Date.now();
  const status = row.status ?? "";

  // 1. Outcome present (rejected / offer / withdrawn) — close the loop.
  // This must come BEFORE the interview check: a rejected row with a
  // historical interview_date is a closure prompt, not a "go practise"
  // prompt. (Stale interview_date on a rejected row happens whenever
  // the user logs an outcome after the interview already happened.)
  if (status === "rejected" || status === "offer" || row.outcome) {
    return { next_action_derived: "close_loop", next_action_due_derived: null };
  }

  // 2. Interview imminent — overrides remaining states.
  if (row.interview_date) {
    const due = new Date(row.interview_date).getTime();
    const days = Math.floor((due - now) / (1000 * 60 * 60 * 24));
    if (days >= 0 && days <= 7) {
      return {
        next_action_derived: "interview",
        next_action_due_derived: new Date(row.interview_date).toISOString(),
      };
    }
  }

  // 3. Submitted ≥ 7 days ago — nudge follow-up.
  if (row.submitted_at) {
    const submitted = new Date(row.submitted_at).getTime();
    const ageDays = Math.floor((now - submitted) / (1000 * 60 * 60 * 24));
    if (ageDays >= 7) {
      const due = new Date(submitted + 7 * 24 * 60 * 60 * 1000).toISOString();
      return { next_action_derived: "follow_up", next_action_due_derived: due };
    }
  }

  // 4. Draft / review states.
  if (status === "review") {
    return { next_action_derived: "submit", next_action_due_derived: null };
  }
  if (status === "draft") {
    return { next_action_derived: "prep", next_action_due_derived: null };
  }

  return { next_action_derived: null, next_action_due_derived: null };
}

function withDerived<T extends Parameters<typeof deriveNextAction>[0]>(
  row: T,
): T & DerivedPair {
  return { ...row, ...deriveNextAction(row) };
}

export { deriveNextAction, withDerived };

export default app;
