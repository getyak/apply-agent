import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

app.post("/prepare", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { jobId, resumeId, coverLetter, formAnswers } = body;

  const result = await query(
    `INSERT INTO application_drafts (user_id, job_id, resume_version_id, cover_letter, form_answers, status)
     VALUES ($1, $2, $3, $4, $5, 'draft')
     RETURNING *`,
    [userId, jobId, resumeId || null, coverLetter || null, formAnswers ? JSON.stringify(formAnswers) : null],
  );
  return c.json({ application: result.rows[0] }, 201);
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  const status = c.req.query("status");

  let sql = `SELECT ad.*, j.company, j.role_title, j.url
     FROM application_drafts ad
     LEFT JOIN jobs j ON ad.job_id = j.id
     WHERE ad.user_id = $1`;
  const params: unknown[] = [userId];

  if (status) {
    params.push(status);
    sql += ` AND ad.status = $${params.length}`;
  }
  sql += " ORDER BY ad.created_at DESC";

  const result = await query(sql, params);
  return c.json({ applications: result.rows });
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const result = await query(
    `SELECT ad.*, j.company, j.role_title, j.url, j.jd_text, j.parsed
     FROM application_drafts ad
     LEFT JOIN jobs j ON ad.job_id = j.id
     WHERE ad.id = $1 AND ad.user_id = $2`,
    [id, userId],
  );
  if (result.rows.length === 0) return c.json({ error: "Application not found" }, 404);
  return c.json({ application: result.rows[0] });
});

app.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json();

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

  if (updates.length === 0) return c.json({ error: "No updates provided" }, 400);

  params.push(id, userId);
  const result = await query(
    `UPDATE application_drafts SET ${updates.join(", ")}
     WHERE id = $${idx++} AND user_id = $${idx}
     RETURNING *`,
    params,
  );
  if (result.rows.length === 0) return c.json({ error: "Application not found" }, 404);
  return c.json({ application: result.rows[0] });
});

export default app;
