import { Hono } from "hono";
import { query } from "../db";
import { cache } from "../cache";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

app.get("/today", async (c) => {
  type TodaySnapshot = {
    totalJobs: number;
    newJobsThisWeek: number;
    topSkills: Record<string, unknown>[];
    topRoles: Record<string, unknown>[];
    generatedAt: string;
  };
  const cacheKey = ["discoverable-v3"];
  try {
    const hit = await cache.get<TodaySnapshot>("trends:today", cacheKey);
    if (hit) return c.json({ snapshot: hit });
  } catch {
    // Redis must never turn an otherwise healthy read-only market snapshot
    // into an outage. Fall through to PostgreSQL and refresh opportunistically.
  }

  const discoverable = `
    is_active = true
    AND company NOT IN ('Example', 'Synthetic', 'Synthetic Labs', 'Synthetic Robotics', 'Synthetic Studio')
    AND company NOT ILIKE '%pasted JD%'
    AND COALESCE(url, '') NOT ILIKE '%/synthetic/%'
  `;
  const [countsResult, rolesResult] = await Promise.all([
    query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (
          WHERE posted_date > NOW() - INTERVAL '7 days'
        ) AS recent
      FROM jobs
      WHERE ${discoverable}
    `),
    query(`
      SELECT role_title, COUNT(*) AS count
      FROM jobs WHERE ${discoverable}
      GROUP BY role_title
      ORDER BY count DESC
      LIMIT 10
    `),
  ]);

  let skillsResult = await query(`
    SELECT skill, COUNT(*) AS count
    FROM jobs, jsonb_array_elements_text(parsed->'skills') AS skill
    WHERE ${discoverable}
      AND jsonb_typeof(parsed->'skills') = 'array'
      AND posted_date > NOW() - INTERVAL '30 days'
    GROUP BY skill
    ORDER BY count DESC
    LIMIT 15
  `);
  // Sparse/older ingests may have no structured skills in the last 30 days.
  // Derive a conservative fallback only from skill names literally present in
  // JD text; this is evidence-backed and avoids a misleading "0 hot skills".
  if (skillsResult.rows.length === 0) {
    skillsResult = await query(`
      WITH vocabulary(skill, pattern) AS (
        VALUES
          ('TypeScript', '(^|[^[:alnum:]])typescript([^[:alnum:]]|$)'),
          ('Python', '(^|[^[:alnum:]])python([^[:alnum:]]|$)'),
          ('Java', '(^|[^[:alnum:]])java([^[:alnum:]]|$)'),
          ('Go', '(^|[^[:alnum:]])go([^[:alnum:]]|$)'),
          ('React', '(^|[^[:alnum:]])react([^[:alnum:]]|$)'),
          ('Node.js', '(^|[^[:alnum:]])node[.]?js([^[:alnum:]]|$)'),
          ('PostgreSQL', '(^|[^[:alnum:]])postgres(ql)?([^[:alnum:]]|$)'),
          ('Redis', '(^|[^[:alnum:]])redis([^[:alnum:]]|$)'),
          ('Kafka', '(^|[^[:alnum:]])kafka([^[:alnum:]]|$)'),
          ('Kubernetes', '(^|[^[:alnum:]])kubernetes([^[:alnum:]]|$)'),
          ('AWS', '(^|[^[:alnum:]])aws([^[:alnum:]]|$)'),
          ('GCP', '(^|[^[:alnum:]])gcp([^[:alnum:]]|$)'),
          ('SQL', '(^|[^[:alnum:]])sql([^[:alnum:]]|$)'),
          ('Machine Learning', '(^|[^[:alnum:]])machine[[:space:]]+learning([^[:alnum:]]|$)'),
          ('Product Management', '(^|[^[:alnum:]])product[[:space:]]+management([^[:alnum:]]|$)'),
          ('Figma', '(^|[^[:alnum:]])figma([^[:alnum:]]|$)')
      )
      SELECT vocabulary.skill, COUNT(*)::int AS count
        FROM jobs
        CROSS JOIN vocabulary
       WHERE ${discoverable}
         AND jd_text ~* vocabulary.pattern
       GROUP BY vocabulary.skill
      HAVING COUNT(*) > 0
       ORDER BY count DESC, vocabulary.skill
       LIMIT 15
    `);
  }

  const snapshot: TodaySnapshot = {
    totalJobs: parseInt(countsResult.rows[0].total),
    newJobsThisWeek: parseInt(countsResult.rows[0].recent),
    topSkills: skillsResult.rows,
    topRoles: rolesResult.rows,
    generatedAt: new Date().toISOString(),
  };
  void cache.set("trends:today", cacheKey, snapshot, 5 * 60).catch(() => {
    // Best-effort cache fill; PostgreSQL response remains authoritative.
  });
  return c.json({ snapshot });
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
