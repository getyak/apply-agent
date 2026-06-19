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
  return c.json(paginated(result.rows, total, { limit, offset }));
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
  return c.json({ application: result.rows[0] });
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
  return c.json({ application: result.rows[0] });
});

export default app;
