import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";
import { validateBody } from "../middleware/validate";
import {
  CreateResumeSchema,
  UpdateResumeSchema,
  ParseResumeSchema,
  ParseResumeAsyncSchema,
} from "../schemas";
import { requireOwnership } from "../ownership";
import { parsePagination, paginated } from "../pagination";
import { cache } from "../cache";
import { llm, LLMUnavailableError } from "../llm";
import { parseResumeText } from "../resume-parse";
import { createJob, getJob, runJob } from "../jobs";
import { ConflictError, NotFoundError, UpstreamError } from "../errors";
import type {
  CreateResume,
  UpdateResume,
  ParseResume,
  ParseResumeAsync,
} from "../schemas";
import type { JsonResume } from "../resume-parse";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

// Prompt discipline (vision red line): the AI may rephrase and strengthen
// existing experience, but MUST NOT invent roles, skills, metrics, or
// achievements. Every optimize/analyze prompt repeats this constraint.
const NO_FABRICATION =
  "CRITICAL: You may rephrase, restructure, and strengthen the wording of " +
  "existing content, but you must NEVER fabricate experience, skills, employers, " +
  "dates, or metrics that are not already present in the resume. If a metric is " +
  "absent, suggest the user add one — do not invent a number.";

interface ResumeSuggestion {
  section: string; // e.g. "work[0].highlights[1]"
  original: string;
  suggested: string;
  reason: string;
}

interface ResumeAnalysis {
  skills: string[];
  strengths: string[];
  gaps: string[];
  metrics: { present: number; missing_opportunities: string[] };
  summary: string;
}

app.post("/", validateBody(CreateResumeSchema), async (c) => {
  const userId = c.get("userId");
  const { content, isBase } = c.get("validatedBody") as CreateResume;

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

// POST /api/resumes/parse — raw resume text → structured JSON Resume. This is
// the real onboarding spine: the client sends extracted/pasted text and gets
// back a JSON Resume the LLM STRUCTURED (never fabricated). With `save:true`
// the parsed result becomes the user's base resume in one round-trip.
//
// Honest degradation: if no LLM is configured we return a clear unavailable
// signal — we never hand back a fake resume.
app.post("/parse", validateBody(ParseResumeSchema), async (c) => {
  const userId = c.get("userId");
  const { text, save } = c.get("validatedBody") as ParseResume;

  let parsed;
  try {
    parsed = await parseResumeText(text);
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      // 502: the structuring step depends on an upstream model that's down or
      // unconfigured. The client shows "parsing unavailable", not a fake result.
      throw new UpstreamError("Resume parsing is unavailable", err.message);
    }
    throw err;
  }

  if (!save) {
    return c.json({ resume: parsed.resume, saved: false, meta: parsed.meta });
  }

  // Persist as the next version (base resume) via the shared helper so the
  // optimistic-lock version sequence stays consistent with the async path.
  const row = await saveBaseResume(userId, parsed.resume);
  return c.json({ resume: row, saved: true, meta: parsed.meta }, 201);
});

/** Persist a parsed resume as the user's next base version (shared by the
 *  synchronous and async paths). */
async function saveBaseResume(userId: string, resume: JsonResume) {
  const versionResult = await query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM resumes WHERE user_id = $1",
    [userId],
  );
  const nextVersion = versionResult.rows[0].next_version;
  const result = await query(
    `INSERT INTO resumes (user_id, content, version, is_base, created_at)
     VALUES ($1, $2, $3, true, NOW())
     RETURNING id, user_id, content, version, is_base, created_at`,
    [userId, JSON.stringify(resume), nextVersion],
  );
  return result.rows[0];
}

/** Shape returned to the client when a parse job finishes. */
interface ParseJobResult {
  resume: JsonResume;
  saved: boolean;
  resumeId?: string;
  meta: { model: string; costCents: number };
}

// POST /api/resumes/parse-async — START an asynchronous parse and return a job
// id immediately (202). This is the key onboarding-UX change: the client no
// longer blocks on the LLM. It uploads → enters the workspace → polls
// GET /parse/:jobId while the parse runs in the background. The parse never
// fabricates — on LLM failure the job ends "failed" with an honest message.
app.post("/parse-async", validateBody(ParseResumeAsyncSchema), async (c) => {
  const userId = c.get("userId");
  const { text, markdown, save } = c.get("validatedBody") as ParseResumeAsync;
  // Prefer the Markdown middle state (richer structure → better parse); fall
  // back to raw text. The upload route already produced Markdown for files.
  const source = (markdown ?? text ?? "").trim();

  const job = await createJob<ParseJobResult>(userId, "resume-parse");

  // Fire-and-forget: the request returns now; the worker updates the job in
  // Redis as it progresses. Bun's long-lived process keeps this promise alive.
  void runJob<ParseJobResult>(job.id, async (step) => {
    await step("parsing");
    const parsed = await parseResumeText(source);
    let saved = false;
    let resumeId: string | undefined;
    if (save) {
      const row = await saveBaseResume(userId, parsed.resume);
      saved = true;
      resumeId = row.id as string;
    }
    return { resume: parsed.resume, saved, resumeId, meta: parsed.meta };
  });

  return c.json({ job }, 202);
});

// GET /api/resumes/parse/:jobId — poll an async parse job. Owner-scoped (a
// non-owner / missing job both 404, enumeration-safe). The client polls this
// until status is "done" (result present) or "failed" (error present).
app.get("/parse/:jobId", async (c) => {
  const userId = c.get("userId");
  const jobId = c.req.param("jobId");
  const job = await getJob<ParseJobResult>(jobId, userId);
  if (!job) throw new NotFoundError("Parse job not found");
  return c.json({ job });
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  const { limit, offset, sort, order } = parsePagination(c.req.query(), {
    sortable: ["version", "created_at"],
    defaultLimit: 20,
  });

  const totalResult = await query(
    "SELECT COUNT(*)::int AS total FROM resumes WHERE user_id = $1",
    [userId],
  );
  const total = totalResult.rows[0].total as number;

  const result = await query(
    // sort/order come from the validated allowlist, so identifier interpolation
    // is safe here; limit/offset stay bound parameters.
    `SELECT id, version, is_base, tailored_for_job, created_at FROM resumes
     WHERE user_id = $1 ORDER BY ${sort} ${order} LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return c.json(paginated(result.rows, total, { limit, offset }));
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const resume = await requireOwnership("resumes", id, userId);
  return c.json({ resume });
});

app.put("/:id", validateBody(UpdateResumeSchema), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id")!; // present by route definition
  const { content, expectedVersion } = c.get("validatedBody") as UpdateResume;

  const result = await query(
    `UPDATE resumes SET content = $1, version = version + 1
     WHERE id = $2 AND user_id = $3 AND version = $4
     RETURNING id, content, version, is_base, created_at`,
    [JSON.stringify(wrapped), id, userId, expectedVersion],
  );
  if (result.rows.length === 0) {
    // Either the row isn't ours/absent, or the version moved under us.
    await requireOwnership("resumes", id, userId, "id"); // throws NotFound if not owned
    throw new ConflictError("Resume version conflict — reload and retry");
  }
  return c.json({ resume: unwrapResumeRow(result.rows[0]) });
});

/** True when `content` is the new wrapper shape (parse output + raw text). */
function isWrappedResume(content: unknown): content is {
  raw: string;
  parsed: JsonResume;
  warnings?: string[];
  parsedAt?: string;
} {
  return (
    !!content &&
    typeof content === "object" &&
    "parsed" in (content as Record<string, unknown>) &&
    "raw" in (content as Record<string, unknown>)
  );
}

/** Flatten the wrapper shape back to a backward-compatible row: the client still
 *  reads `content.basics / content.work / ...` like before, with the new
 *  metadata available as `_raw / _warnings / _parsedAt`. */
function unwrapResumeRow(row: Record<string, unknown>): Record<string, unknown> {
  if (!isWrappedResume(row.content)) return row;
  const { raw, parsed, warnings, parsedAt } = row.content;
  return {
    ...row,
    content: {
      ...parsed,
      _raw: raw,
      _warnings: warnings ?? [],
      _parsedAt: parsedAt ?? null,
    },
  };
}

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await requireOwnership("resumes", id, userId, "id"); // 404 if not owned
  await query("DELETE FROM resumes WHERE id = $1 AND user_id = $2", [id, userId]);
  return c.json({ ok: true });
});

// AI optimization: returns a set of suggested rephrasings (a diff the user
// reviews and accepts), NOT an edited resume. The resume is never mutated
// server-side here — "AI proposes, user disposes" (vision principle 4).
// An optional JD biases suggestions toward that role.
// Idempotency: LLM calls are expensive; duplicate requests replay the first result.
app.post("/:id/optimize", idempotency(), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const jobDescription: string | undefined =
    typeof body.jobDescription === "string" ? body.jobDescription : undefined;

  const result = await query(
    "SELECT content FROM resumes WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  if (result.rows.length === 0) throw new NotFoundError("Resume not found");
  const content = result.rows[0].content;

  if (!llm.available) {
    // Honest degraded response — no fake suggestions.
    return c.json({
      suggestions: [],
      aiGenerated: false,
      note: "AI optimization is unavailable (no LLM configured).",
    });
  }

  try {
    const { data, meta } = await llm.chatJSON<{ suggestions: ResumeSuggestion[] }>(
      [
        {
          role: "system",
          content:
            "You are an expert resume editor. Suggest concrete, high-impact rephrasings of existing bullet points and summaries. " +
            'Return JSON: {"suggestions":[{"section":string,"original":string,"suggested":string,"reason":string}]}. ' +
            "Use strong action verbs, surface impact, and improve clarity. " +
            NO_FABRICATION,
        },
        {
          role: "user",
          content:
            (jobDescription
              ? `Target job description:\n${jobDescription.slice(0, 3000)}\n\n`
              : "") + `Resume (JSON Resume):\n${JSON.stringify(content).slice(0, 6000)}`,
        },
      ],
      { tier: "general", temperature: 0.5, maxTokens: 1800 },
    );

    const suggestions = (data.suggestions ?? []).filter(
      (s) =>
        s &&
        typeof s.original === "string" &&
        typeof s.suggested === "string" &&
        s.original !== s.suggested,
    );

    return c.json({
      suggestions,
      aiGenerated: true,
      meta: { model: meta.model, costCents: meta.costCents },
    });
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      throw new UpstreamError("Resume optimization failed", err.message);
    }
    throw err;
  }
});

// AI analysis: extract skills, strengths, gaps, and metric opportunities.
// Cached (resume content is stable until a new version is written).
app.get("/:id/analyze", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const result = await query(
    "SELECT content, version FROM resumes WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  if (result.rows.length === 0) throw new NotFoundError("Resume not found");
  const { content, version } = result.rows[0];

  if (!llm.available) {
    return c.json({ analysis: null, aiGenerated: false, note: "AI analysis unavailable (no LLM configured)." });
  }

  try {
    const analysis = await cache.getOrSet<ResumeAnalysis>(
      "resume:tailored",
      [userId, id, version, "analyze"],
      async () => {
        const { data } = await llm.chatJSON<ResumeAnalysis>(
          [
            {
              role: "system",
              content:
                "You are a resume analyst. Extract a structured assessment. " +
                'Return JSON: {"skills":string[],"strengths":string[],"gaps":string[],' +
                '"metrics":{"present":number,"missing_opportunities":string[]},"summary":string}. ' +
                "skills = technologies/competencies actually evidenced. gaps = areas a hiring manager " +
                "might find thin. metrics.present = count of quantified achievements. " +
                "missing_opportunities = bullets that would be stronger with a number. " +
                NO_FABRICATION,
            },
            { role: "user", content: `Resume (JSON Resume):\n${JSON.stringify(content).slice(0, 6000)}` },
          ],
          { tier: "fast", temperature: 0.3, maxTokens: 1200 },
        );
        return data;
      },
    );

    return c.json({ analysis, aiGenerated: true });
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      throw new UpstreamError("Resume analysis failed", err.message);
    }
    throw err;
  }
});

export default app;
