import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

app.get("/today", async (c) => {
  const totalResult = await query("SELECT COUNT(*) AS total FROM jobs WHERE is_active = true");
  const recentResult = await query(
    "SELECT COUNT(*) AS recent FROM jobs WHERE is_active = true AND posted_date > NOW() - INTERVAL '7 days'",
  );

  const skillsResult = await query(`
    SELECT skill, COUNT(*) AS count
    FROM jobs, jsonb_array_elements_text(parsed->'skills') AS skill
    WHERE is_active = true AND posted_date > NOW() - INTERVAL '30 days'
    GROUP BY skill
    ORDER BY count DESC
    LIMIT 15
  `);

  const rolesResult = await query(`
    SELECT role_title, COUNT(*) AS count
    FROM jobs WHERE is_active = true
    GROUP BY role_title
    ORDER BY count DESC
    LIMIT 10
  `);

  return c.json({
    snapshot: {
      totalJobs: parseInt(totalResult.rows[0].total),
      newJobsThisWeek: parseInt(recentResult.rows[0].recent),
      topSkills: skillsResult.rows,
      topRoles: rolesResult.rows,
      generatedAt: new Date().toISOString(),
    },
  });
});

app.get("/personalized", async (c) => {
  const userId = c.get("userId");

  const resumeResult = await query(
    "SELECT content FROM resumes WHERE user_id = $1 AND is_base = true ORDER BY version DESC LIMIT 1",
    [userId],
  );

  const userSkills: string[] = [];
  if (resumeResult.rows.length > 0) {
    const content = typeof resumeResult.rows[0].content === "string"
      ? JSON.parse(resumeResult.rows[0].content) : resumeResult.rows[0].content;
    if (content?.skills) {
      for (const s of content.skills) {
        userSkills.push(typeof s === "string" ? s : s.name);
      }
    }
  }

  const trendingResult = await query(`
    SELECT skill, COUNT(*) AS demand
    FROM jobs, jsonb_array_elements_text(parsed->'skills') AS skill
    WHERE is_active = true AND posted_date > NOW() - INTERVAL '30 days'
    GROUP BY skill
    ORDER BY demand DESC
    LIMIT 20
  `);

  const trending = trendingResult.rows.map((r) => r.skill as string);
  const userSkillsLower = userSkills.map((s) => s.toLowerCase());

  const missingSkills = trending.filter(
    (s) => !userSkillsLower.includes(s.toLowerCase()),
  );

  const matchingSkills = trending.filter(
    (s) => userSkillsLower.includes(s.toLowerCase()),
  );

  return c.json({
    personalized: {
      yourSkills: userSkills,
      trendingSkills: trending,
      youHave: matchingSkills,
      youNeed: missingSkills.slice(0, 5),
      insight: missingSkills.length > 0
        ? `Learning ${missingSkills[0]} could unlock more job matches based on current market demand.`
        : "Your skills are well-aligned with current market trends!",
    },
  });
});

export default app;
