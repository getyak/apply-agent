import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { cache } from "../cache";
import { llm, LLMUnavailableError } from "../llm";
import { NotFoundError } from "../errors";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

// Match scoring weights (sum to 1.0), per the product spec:
// skills 45% / level 25% / location 20% / salary 10%.
const WEIGHTS = { skills: 0.45, level: 0.25, location: 0.2, salary: 0.1 };

interface MatchBreakdown {
  skills: number; // each 0-1
  level: number;
  location: number;
  salary: number;
}

interface MatchResult {
  score: number; // 0-100
  matchedSkills: string[];
  missingSkills: string[];
  breakdown: MatchBreakdown;
  rationale?: string;
  aiGenerated: boolean;
}

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
  const result = await query("SELECT * FROM jobs WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new NotFoundError("Job not found");
  return c.json({ job: result.rows[0] });
});

app.post("/:id/match", async (c) => {
  const userId = c.get("userId");
  const jobId = c.req.param("id");

  const jobResult = await query(
    "SELECT parsed, jd_text, role_title FROM jobs WHERE id = $1",
    [jobId],
  );
  if (jobResult.rows.length === 0) throw new NotFoundError("Job not found");

  const resumeResult = await query(
    "SELECT id, content, version FROM resumes WHERE user_id = $1 AND is_base = true ORDER BY version DESC LIMIT 1",
    [userId],
  );
  if (resumeResult.rows.length === 0) throw new NotFoundError("No base resume found");

  const job = jobResult.rows[0];
  const resume = resumeResult.rows[0];
  const jobParsed = parseMaybe(job.parsed);
  const resumeContent = parseMaybe(resume.content);

  // Cache keyed by user resume version + job id so a resume edit invalidates.
  const match = await cache.getOrSet<MatchResult>(
    "match:score",
    [userId, jobId, resume.version],
    () => computeMatch(jobParsed, job.jd_text, resumeContent),
  );

  return c.json({ match });
});

function parseMaybe(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v as Record<string, unknown>;
}

/**
 * Compute a weighted match score. Uses the LLM for a semantic assessment of
 * skills/level/location/salary fit; falls back to lexical skill overlap when
 * the LLM is unavailable so the endpoint always returns a usable score.
 */
async function computeMatch(
  jobParsed: Record<string, unknown> | null,
  jdText: string | null,
  resumeContent: Record<string, unknown> | null,
): Promise<MatchResult> {
  if (llm.available) {
    try {
      return await llmMatch(jobParsed, jdText, resumeContent);
    } catch (err) {
      if (!(err instanceof LLMUnavailableError)) throw err;
      // fall through to lexical
    }
  }
  return lexicalMatch(jobParsed, resumeContent);
}

async function llmMatch(
  jobParsed: Record<string, unknown> | null,
  jdText: string | null,
  resumeContent: Record<string, unknown> | null,
): Promise<MatchResult> {
  const jobSkills = extractJobSkills(jobParsed);
  const { data } = await llm.chatJSON<{
    breakdown: MatchBreakdown;
    matchedSkills: string[];
    missingSkills: string[];
    rationale: string;
  }>(
    [
      {
        role: "system",
        content:
          "You assess how well a candidate's resume fits a job. Consider semantic skill overlap (a resume listing 'React' matches a JD wanting 'frontend frameworks'), seniority/level fit, location/remote fit, and salary fit. " +
          'Return JSON: {"breakdown":{"skills":0-1,"level":0-1,"location":0-1,"salary":0-1},"matchedSkills":string[],"missingSkills":string[],"rationale":string}. ' +
          "Each breakdown value is a 0-1 sub-score. Base everything strictly on the provided data; if a dimension is unknown, score it 0.5 (neutral). Be honest, not flattering.",
      },
      {
        role: "user",
        content:
          `JOB:\n${jdText ? jdText.slice(0, 3000) : JSON.stringify(jobParsed)}\n\n` +
          `Known JD skills: ${jobSkills.join(", ") || "(none parsed)"}\n\n` +
          `RESUME:\n${JSON.stringify(resumeContent).slice(0, 4000)}`,
      },
    ],
    { tier: "fast", temperature: 0.3, maxTokens: 800 },
  );

  const breakdown = normalizeBreakdown(data.breakdown);
  const score = Math.round(
    (breakdown.skills * WEIGHTS.skills +
      breakdown.level * WEIGHTS.level +
      breakdown.location * WEIGHTS.location +
      breakdown.salary * WEIGHTS.salary) *
      100,
  );

  return {
    score,
    matchedSkills: Array.isArray(data.matchedSkills) ? data.matchedSkills : [],
    missingSkills: Array.isArray(data.missingSkills) ? data.missingSkills : [],
    breakdown,
    rationale: typeof data.rationale === "string" ? data.rationale : undefined,
    aiGenerated: true,
  };
}

/** Deterministic lexical fallback — case-insensitive skill overlap only. */
function lexicalMatch(
  jobParsed: Record<string, unknown> | null,
  resumeContent: Record<string, unknown> | null,
): MatchResult {
  const jobSkills = extractJobSkills(jobParsed);
  const resumeSkills = extractResumeSkills(resumeContent);

  const matchedSkills = jobSkills.filter((s) =>
    resumeSkills.some((rs) => rs.toLowerCase().includes(s.toLowerCase())),
  );
  const skillScore = jobSkills.length > 0 ? matchedSkills.length / jobSkills.length : 0.5;

  // Only the skills dimension is known lexically; others stay neutral (0.5).
  const breakdown: MatchBreakdown = { skills: skillScore, level: 0.5, location: 0.5, salary: 0.5 };
  const score = Math.round(
    (breakdown.skills * WEIGHTS.skills +
      breakdown.level * WEIGHTS.level +
      breakdown.location * WEIGHTS.location +
      breakdown.salary * WEIGHTS.salary) *
      100,
  );

  return {
    score,
    matchedSkills,
    missingSkills: jobSkills.filter((s) => !matchedSkills.includes(s)),
    breakdown,
    aiGenerated: false,
  };
}

function normalizeBreakdown(b: Partial<MatchBreakdown> | undefined): MatchBreakdown {
  const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0.5));
  return {
    skills: clamp(b?.skills),
    level: clamp(b?.level),
    location: clamp(b?.location),
    salary: clamp(b?.salary),
  };
}

function extractJobSkills(jobParsed: Record<string, unknown> | null): string[] {
  const skills = jobParsed?.skills;
  return Array.isArray(skills) ? (skills as string[]).filter((s) => typeof s === "string") : [];
}

function extractResumeSkills(resumeContent: Record<string, unknown> | null): string[] {
  const skills = resumeContent?.skills;
  if (!Array.isArray(skills)) return [];
  return (skills as { name?: string }[])
    .map((s) => s?.name)
    .filter((n): n is string => typeof n === "string");
}

export default app;
