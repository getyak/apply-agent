import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

app.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") || "20");
  const offset = parseInt(c.req.query("offset") || "0");
  const search = c.req.query("search");

  let sql = "SELECT id, company, role_title, url, source, posted_date, parsed, is_active FROM jobs WHERE is_active = true";
  const params: unknown[] = [];

  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (role_title ILIKE $${params.length} OR company ILIKE $${params.length})`;
  }

  sql += ` ORDER BY posted_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return c.json({ jobs: result.rows });
});

app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const result = await query(
    "SELECT * FROM jobs WHERE id = $1",
    [id],
  );
  if (result.rows.length === 0) return c.json({ error: "Job not found" }, 404);
  return c.json({ job: result.rows[0] });
});

app.post("/:id/match", async (c) => {
  const userId = c.get("userId");
  const jobId = c.req.param("id");

  const jobResult = await query("SELECT parsed FROM jobs WHERE id = $1", [jobId]);
  if (jobResult.rows.length === 0) return c.json({ error: "Job not found" }, 404);

  const resumeResult = await query(
    "SELECT content FROM resumes WHERE user_id = $1 AND is_base = true ORDER BY version DESC LIMIT 1",
    [userId],
  );
  if (resumeResult.rows.length === 0) return c.json({ error: "No base resume found" }, 404);

  const jobParsed = typeof jobResult.rows[0].parsed === "string"
    ? JSON.parse(jobResult.rows[0].parsed) : jobResult.rows[0].parsed;
  const resumeContent = typeof resumeResult.rows[0].content === "string"
    ? JSON.parse(resumeResult.rows[0].content) : resumeResult.rows[0].content;

  const jobSkills: string[] = jobParsed?.skills || [];
  const resumeSkills: string[] = resumeContent?.skills?.map((s: { name: string }) => s.name) || [];

  const matchedSkills = jobSkills.filter((s) =>
    resumeSkills.some((rs) => rs.toLowerCase().includes(s.toLowerCase())),
  );
  const skillScore = jobSkills.length > 0 ? matchedSkills.length / jobSkills.length : 0;

  const score = Math.round(skillScore * 100);

  return c.json({
    match: {
      score,
      matchedSkills,
      missingSkills: jobSkills.filter((s) => !matchedSkills.includes(s)),
      breakdown: { skills: skillScore * 0.45, level: 0.2, location: 0.15, salary: 0.05 },
    },
  });
});

export default app;
