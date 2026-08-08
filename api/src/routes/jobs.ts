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
  const userId = c.get("userId");
  const limit = parseInt(c.req.query("limit") || "20");
  const offset = parseInt(c.req.query("offset") || "0");
  const search = c.req.query("search");

  let sql = `WITH active_resume AS (
                SELECT COALESCE(content->'parsed', content) AS profile
                  FROM resumes
                 WHERE user_id = $1 AND is_base = true
                 ORDER BY version DESC
                 LIMIT 1
              ),
              user_skills AS (
                SELECT DISTINCT lower(
                  CASE
                    WHEN jsonb_typeof(item) = 'string'
                      THEN trim(both '"' from item::text)
                    ELSE item->>'name'
                  END
                ) AS skill
                  FROM active_resume,
                       jsonb_array_elements(
                         CASE
                           WHEN jsonb_typeof(profile->'skills') = 'array'
                             THEN profile->'skills'
                           ELSE '[]'::jsonb
                         END
                       ) AS item
                 WHERE COALESCE(
                   CASE
                     WHEN jsonb_typeof(item) = 'string'
                       THEN trim(both '"' from item::text)
                     ELSE item->>'name'
                   END,
                   ''
                 ) <> ''
              ),
              user_roles AS (
                SELECT lower(profile->'basics'->>'label') AS role
                  FROM active_resume
                 WHERE COALESCE(profile->'basics'->>'label', '') <> ''
                UNION
                SELECT DISTINCT lower(item->>'position') AS role
                  FROM active_resume,
                       jsonb_array_elements(
                         CASE
                           WHEN jsonb_typeof(profile->'work') = 'array'
                             THEN profile->'work'
                           ELSE '[]'::jsonb
                         END
                       ) AS item
                 WHERE COALESCE(item->>'position', '') <> ''
              )
              SELECT j.id, j.company, j.role_title, j.url, j.source,
                     j.posted_date, j.parsed, j.is_active,
                     COALESCE((
                       SELECT COUNT(DISTINCT jd_skill)
                         FROM jsonb_array_elements_text(
                           CASE
                             WHEN jsonb_typeof(j.parsed->'skills') = 'array'
                               THEN j.parsed->'skills'
                             ELSE '[]'::jsonb
                           END
                         ) AS jd_skill
                         JOIN user_skills us
                           ON lower(jd_skill) = us.skill
                           OR lower(jd_skill) LIKE '%' || us.skill || '%'
                           OR us.skill LIKE '%' || lower(jd_skill) || '%'
                     ), 0)::int AS skill_overlap,
                     COALESCE((
                       SELECT MAX(similarity(lower(j.role_title), ur.role))
                         FROM user_roles ur
                     ), 0)::float AS role_similarity
                FROM jobs j
               WHERE j.is_active = true
                 AND j.company NOT IN ('Example', 'Synthetic', 'Synthetic Labs', 'Synthetic Robotics', 'Synthetic Studio')
                 AND j.company NOT ILIKE '%pasted JD%'
                 AND COALESCE(j.url, '') NOT ILIKE '%/synthetic/%'`;
  const params: unknown[] = [userId];

  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (j.role_title ILIKE $${params.length} OR j.company ILIKE $${params.length})`;
  }

  sql += ` ORDER BY role_similarity DESC, skill_overlap DESC, j.posted_date DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return c.json({ jobs: result.rows });
});

/**
 * Score a page of jobs in one round-trip. The previous web loader issued one
 * POST per card, multiplying navigation traffic and surfacing twenty 404s
 * while a base résumé was still being created. List scoring is deliberately
 * deterministic and local: opening Today must not fan out to twenty model
 * calls. The single-job endpoint remains available for a deeper AI rationale.
 * Missing résumé is a normal 200 readiness state.
 */
app.post("/matches", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const requested = Array.isArray((body as { jobIds?: unknown }).jobIds)
    ? (body as { jobIds: unknown[] }).jobIds
    : [];
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const jobIds = [
    ...new Set(
      requested.filter(
        (value): value is string => typeof value === "string" && uuid.test(value),
      ),
    ),
  ].slice(0, 50);
  if (jobIds.length === 0) {
    return c.json(
      { error: { code: "INVALID_JOB_IDS", message: "jobIds must contain UUIDs" } },
      400,
    );
  }

  const resumeResult = await query(
    "SELECT id, content, version FROM resumes WHERE user_id = $1 AND is_base = true ORDER BY version DESC LIMIT 1",
    [userId],
  );
  if (resumeResult.rows.length === 0) {
    return c.json({
      matches: {},
      unavailableJobIds: jobIds,
      unavailableReason: "no_base_resume",
    });
  }

  const jobsResult = await query(
    `SELECT id, parsed, jd_text, role_title
       FROM jobs
      WHERE id = ANY($1::uuid[]) AND is_active = true`,
    [jobIds],
  );
  const resume = resumeResult.rows[0];
  const resumeContent = parseMaybe(resume.content);
  const matches: Record<string, MatchResult> = {};

  for (const job of jobsResult.rows) {
    const jobId = String(job.id);
    matches[jobId] = lexicalMatch(
      parseMaybe(job.parsed),
      resumeContent,
      job.jd_text,
      job.role_title,
    );
  }

  const scored = new Set(Object.keys(matches));
  return c.json({
    matches,
    unavailableJobIds: jobIds.filter((id) => !scored.has(id)),
    unavailableReason: null,
  });
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
    [userId, jobId, resume.version, "resume-profile-v2"],
    () => computeMatch(jobParsed, job.jd_text, resumeContent, job.role_title),
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
  roleTitle: string | null,
): Promise<MatchResult> {
  if (llm.available) {
    try {
      return await llmMatch(jobParsed, jdText, resumeContent);
    } catch (err) {
      if (!(err instanceof LLMUnavailableError)) throw err;
      // fall through to lexical
    }
  }
  return lexicalMatch(jobParsed, resumeContent, jdText, roleTitle);
}

async function llmMatch(
  jobParsed: Record<string, unknown> | null,
  jdText: string | null,
  resumeContent: Record<string, unknown> | null,
): Promise<MatchResult> {
  const jobSkills = extractJobSkills(jobParsed);
  const resumeProfile = extractResumeProfile(resumeContent);
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
          `RESUME:\n${JSON.stringify(resumeProfile).slice(0, 4000)}`,
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

/**
 * Deterministic list/fallback score. Parsed JD skills are preferred. Many
 * feeds do not populate that field, so in that case we only credit résumé
 * skills that are explicitly present in the source JD. Role-family overlap is
 * used as the best local approximation for the level dimension.
 */
export function lexicalMatch(
  jobParsed: Record<string, unknown> | null,
  resumeContent: Record<string, unknown> | null,
  jdText: string | null = null,
  roleTitle: string | null = null,
): MatchResult {
  const resumeSkills = extractResumeSkills(resumeContent);
  const parsedJobSkills = extractJobSkills(jobParsed);
  const inferredJobSkills =
    parsedJobSkills.length === 0
      ? resumeSkills.filter((skill) => textMentionsSkill(jdText ?? "", skill))
      : [];
  const jobSkills =
    parsedJobSkills.length > 0 ? parsedJobSkills : inferredJobSkills;

  const matchedSkills = jobSkills.filter((s) =>
    resumeSkills.some((rs) => skillsMatch(rs, s)),
  );
  const skillScore =
    parsedJobSkills.length > 0
      ? matchedSkills.length / parsedJobSkills.length
      : inferredJobSkills.length > 0
        ? Math.min(1, 0.5 + inferredJobSkills.length * 0.1)
        : 0.5;
  const roleScore = lexicalRoleFit(
    roleTitle ?? "",
    extractResumeRoles(resumeContent),
  );

  // Location and salary stay explicitly neutral when the local data cannot
  // support a claim. The AI detail endpoint can assess those dimensions.
  const breakdown: MatchBreakdown = {
    skills: skillScore,
    level: roleScore,
    location: 0.5,
    salary: 0.5,
  };
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

export function normalizeBreakdown(
  b: Partial<MatchBreakdown> | undefined,
): MatchBreakdown {
  const clamp = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 0.5;
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
  const skills = extractResumeProfile(resumeContent)?.skills;
  if (!Array.isArray(skills)) return [];
  return skills
    .map((skill) =>
      typeof skill === "string"
        ? skill
        : skill && typeof skill === "object"
          ? (skill as { name?: unknown }).name
          : undefined,
    )
    .filter((n): n is string => typeof n === "string");
}

function extractResumeRoles(
  resumeContent: Record<string, unknown> | null,
): string[] {
  const profile = extractResumeProfile(resumeContent);
  if (!profile) return [];
  const roles: string[] = [];
  const basics = profile.basics;
  if (basics && typeof basics === "object" && !Array.isArray(basics)) {
    const label = (basics as { label?: unknown }).label;
    if (typeof label === "string" && label.trim()) roles.push(label.trim());
  }
  const work = profile.work;
  if (Array.isArray(work)) {
    for (const item of work) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const position = (item as { position?: unknown }).position;
      if (typeof position === "string" && position.trim()) {
        roles.push(position.trim());
      }
    }
  }
  return [...new Set(roles)];
}

const SKILL_ALIASES: Record<string, string[]> = {
  postgresql: ["postgresql", "postgres"],
  "rest apis": ["rest api", "restful api", "restful services"],
  observability: ["observability", "monitoring", "telemetry"],
  aws: ["aws", "amazon web services"],
};

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
}

function textMentionsSkill(text: string, skill: string): boolean {
  const haystack = ` ${normalizedText(text)} `;
  const normalizedSkill = normalizedText(skill);
  const aliases = SKILL_ALIASES[normalizedSkill] ?? [normalizedSkill];
  return aliases.some((alias) => haystack.includes(` ${alias} `));
}

function skillsMatch(resumeSkill: string, jobSkill: string): boolean {
  const left = normalizedText(resumeSkill);
  const right = normalizedText(jobSkill);
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const aliases = SKILL_ALIASES[left] ?? [left];
  return aliases.includes(right);
}

const ROLE_LEVEL_WORDS = new Set([
  "junior",
  "jr",
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "i",
  "ii",
  "iii",
  "all",
  "levels",
]);

function roleSeniority(role: string): number | null {
  const normalized = normalizedText(role);
  if (/\b(principal)\b/.test(normalized)) return 5;
  if (/\b(staff)\b/.test(normalized)) return 4;
  if (/\b(senior|sr|lead)\b/.test(normalized)) return 3;
  if (/\b(mid|intermediate|ii)\b/.test(normalized)) return 2;
  if (/\b(junior|jr|entry|graduate|i)\b/.test(normalized)) return 1;
  if (/\b(intern|internship)\b/.test(normalized)) return 0;
  return null;
}

function roleFamilyTokens(role: string): Set<string> {
  return new Set(
    normalizedText(role)
      .split(" ")
      .filter((token) => token && !ROLE_LEVEL_WORDS.has(token)),
  );
}

function lexicalRoleFit(jobRole: string, resumeRoles: string[]): number {
  if (!jobRole.trim() || resumeRoles.length === 0) return 0.5;
  const jobTokens = roleFamilyTokens(jobRole);
  if (jobTokens.size === 0) return 0.5;
  let best = 0;
  for (const resumeRole of resumeRoles) {
    const resumeTokens = roleFamilyTokens(resumeRole);
    const shared = [...jobTokens].filter((token) => resumeTokens.has(token)).length;
    const union = new Set([...jobTokens, ...resumeTokens]).size;
    best = Math.max(best, union > 0 ? shared / union : 0);
  }
  if (best < 0.34) return 0.3;

  const jobSeniority = roleSeniority(jobRole);
  const resumeSeniorities = resumeRoles
    .map(roleSeniority)
    .filter((level): level is number => level !== null);
  if (jobSeniority === null || resumeSeniorities.length === 0) return 0.5;

  const nearestGap = Math.min(
    ...resumeSeniorities.map((level) => Math.abs(level - jobSeniority)),
  );
  if (nearestGap === 0) return best >= 0.66 ? 1 : 0.85;
  if (nearestGap === 1) return 0.7;
  return 0.35;
}

function extractResumeProfile(
  resumeContent: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const parsed = resumeContent?.parsed;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : resumeContent;
}

export default app;
