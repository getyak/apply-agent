import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { content, isBase } = body;

  const versionResult = await query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM resumes WHERE user_id = $1",
    [userId],
  );
  const nextVersion = versionResult.rows[0].next_version;

  const result = await query(
    `INSERT INTO resumes (user_id, content, version, is_base, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, user_id, content, version, is_base, created_at`,
    [userId, JSON.stringify(content), nextVersion, isBase ?? true],
  );
  return c.json({ resume: result.rows[0] }, 201);
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  const result = await query(
    "SELECT id, version, is_base, tailored_for_job, created_at FROM resumes WHERE user_id = $1 ORDER BY version DESC",
    [userId],
  );
  return c.json({ resumes: result.rows });
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const result = await query(
    "SELECT * FROM resumes WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  if (result.rows.length === 0) return c.json({ error: "Resume not found" }, 404);
  return c.json({ resume: result.rows[0] });
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json();
  const { content, expectedVersion } = body;

  const result = await query(
    `UPDATE resumes SET content = $1, version = version + 1
     WHERE id = $2 AND user_id = $3 AND version = $4
     RETURNING id, content, version, is_base, created_at`,
    [JSON.stringify(content), id, userId, expectedVersion],
  );
  if (result.rows.length === 0) {
    return c.json({ error: "Version conflict or resume not found" }, 409);
  }
  return c.json({ resume: result.rows[0] });
});

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await query("DELETE FROM resumes WHERE id = $1 AND user_id = $2", [id, userId]);
  return c.json({ ok: true });
});

export default app;
