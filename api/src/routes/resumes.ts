import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";
import { rateLimit } from "../middleware/rate-limit";
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
import { jsonResumeToMarkdown } from "../resume-markdown";
import { resolveLocale } from "../locale";
import {
  EXPORT_MIME,
  exportFilename,
  exportJson,
  exportMarkdown,
  isExportFormat,
  type ExportFormat,
} from "../resume-export";
import { pdfRenderAvailable, renderResumePdf } from "../pdf-render";
import { docxExportAvailable, renderResumeDocx } from "../docx-export";
import { createJob, getJob, runJob } from "../jobs";
import { config } from "../config";
import {
  ConflictError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "../errors";
import { randomBytes } from "node:crypto";
import type {
  CreateResume,
  UpdateResume,
  ParseResume,
  ParseResumeAsync,
} from "../schemas";
import type { JsonResume, ParseResult } from "../resume-parse";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

// API_RL1 (round-7): /parse-async kicks off an LLM-backed background
// parse job. Before round-7 it had no per-user ceiling, so a misbehaving
// client (or a malicious one) could enqueue jobs as fast as it could
// fire requests. 8 starts/minute leaves room for the realistic "user
// re-uploads after a bad result" pattern but rules out runaway loops.
const parseAsyncLimiter = rateLimit({
  scope: "resume_parse_async",
  limit: 8,
  windowSeconds: 60,
});

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
  // Render the canonical Markdown in the locale of the writing request so a
  // zh user's first impression of "Optimized" matches their UI chrome (no
  // mid-document English EXPERIENCE heading). The persisted markdown is the
  // contract; the unwrap fallback below uses the same per-request locale.
  const locale = resolveLocale(c);

  // Wrap the incoming JSON Resume in the envelope shape (design §11.3) so the
  // row carries a Markdown main track from the very first write. Without this
  // the row would be opaque to the Optimized tab and the unwrapResumeRow
  // legacy-fallback would have to regenerate markdown on every read — wasteful
  // and inconsistent across writers.
  const wrapped = {
    raw: "",
    parsed: content,
    markdown: jsonResumeToMarkdown(content, { locale }),
    warnings: [] as string[],
    parsedAt: new Date().toISOString(),
  };
  // version=0 → migration 016's BEFORE INSERT trigger assigns the next
  // per-user version under an advisory lock. No app-level MAX+1 race.
  const result = await query(
    `INSERT INTO resumes (user_id, content, version, is_base, created_at)
     VALUES ($1, $2, 0, $3, NOW())
     RETURNING id, user_id, content, version, is_base, created_at`,
    [userId, JSON.stringify(wrapped), isBase ?? true],
  );
  return c.json({ resume: unwrapResumeRow(result.rows[0], locale) }, 201);
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
  const { text, save, sourceFileId } = c.get("validatedBody") as ParseResume;

  let parsed;
  try {
    parsed = await parseResumeText(text);
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      // The only case parseResumeText still throws is "raw text empty" — that
      // means the upload route should have rejected this earlier. Treat as 502.
      throw new UpstreamError("Resume parsing is unavailable", err.message);
    }
    throw err;
  }

  if (!save) {
    return c.json({
      resume: parsed.resume,
      saved: false,
      warnings: parsed.warnings,
      usedFallback: parsed.usedFallback,
      meta: parsed.meta,
    });
  }

  const row = await saveBaseResume(userId, parsed, sourceFileId, resolveLocale(c));
  return c.json(
    {
      resume: row,
      saved: true,
      warnings: parsed.warnings,
      usedFallback: parsed.usedFallback,
      meta: parsed.meta,
    },
    201,
  );
});

/**
 * Persist a parsed resume as the user's base. Re-uploads OVERWRITE the existing
 * base row instead of creating a new version: the raw text is the source of
 * truth and we don't want a bad AI parse to bury the user's good v2 behind a
 * broken v3. Tailored resumes (is_base=false, tailored_for_job=…) are
 * untouched — version sequencing still matters for them.
 *
 * Storage shape: { raw, parsed, warnings, parsedAt }. The raw text is the spine
 * — if AI ever choked we can re-parse later without asking the user to re-upload.
 */
async function saveBaseResume(
  userId: string,
  parsed: ParseResult,
  sourceFileId: string | undefined,
  locale: "en" | "zh" = "en",
) {
  // If the caller pointed us at an uploaded file, fetch its metadata so the
  // saved résumé can show a "Source · resume.pdf" chip in the studio without
  // a second round-trip. Ownership-scoped — a forged id from another user
  // simply yields no row and `source` stays undefined.
  let source:
    | {
        fileId: string;
        fileName: string;
        mime: string;
        sizeBytes: number;
      }
    | undefined;
  if (sourceFileId) {
    const fileRow = await query(
      `SELECT id, filename, mime_type, size_bytes
         FROM user_files
        WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
      [sourceFileId, userId],
    );
    if (fileRow.rows.length > 0) {
      const r = fileRow.rows[0];
      source = {
        fileId: r.id as string,
        fileName: (r.filename as string) ?? "resume",
        mime: (r.mime_type as string) ?? "application/octet-stream",
        sizeBytes: Number(r.size_bytes ?? 0),
      };
    }
  }

  // Dual-format storage (design §11.3): we keep three views of the same résumé.
  //   - raw       — the extracted text (what the LLM saw). Debug + re-parse path.
  //   - parsed    — JSON Resume (the structured side-index for matching/skills).
  //   - markdown  — canonical GFM (the human-readable main track that the
  //                 .resume-prose theme renders, the LLM edits, and diffs cleanly).
  // markdown is generated deterministically from `parsed` here so a re-render
  // always matches the JSON. The "Markdown main, JSON side" contract holds as
  // long as both come from the same parse. Future writers (optimize_general,
  // customize) keep the contract by updating both on every write.
  const markdown = jsonResumeToMarkdown(parsed.resume, { locale });
  const content = {
    raw: parsed.raw,
    parsed: parsed.resume,
    markdown,
    warnings: parsed.warnings,
    parsedAt: new Date().toISOString(),
    ...(source ? { source } : {}),
  };

  // Re-upload semantics changed with migration 017 (dual-track model):
  // originals are IMMUTABLE — the prevent_original_mutation trigger rejects any
  // content change on a track='original' row. So a re-upload can no longer
  // UPDATE the base in place; it INSERTs a NEW track='original' row (the old
  // one is preserved, satisfying the "your upload is a contract" promise in
  // docs/design/resume-original-vs-optimized-vibe-design.md §3.1/§7.2).
  //
  // To keep legacy `WHERE is_base = true` readers correct (they expect one
  // current base), we demote any prior base to is_base = false first. That
  // UPDATE only touches the is_base flag, not content, so the immutability
  // trigger allows it. The INSERT passes version = 0 so migration 016's trigger
  // assigns the next per-user version under an advisory lock (no 23505 race).
  await query(
    `UPDATE resumes SET is_base = false
       WHERE user_id = $1 AND is_base = true`,
    [userId],
  );

  const insert = await query(
    `INSERT INTO resumes (user_id, content, version, is_base, track, source_file_id, created_at)
     VALUES ($1, $2, 0, true, 'original', $3, NOW())
     RETURNING id, user_id, content, version, is_base, created_at`,
    [userId, JSON.stringify(content), sourceFileId ?? null],
  );
  return insert.rows[0];
}

/**
 * Fire-and-forget chain into the Python agent's no-JD optimize pass.
 * Best-effort: any failure (agent down, parse race) is logged, never thrown —
 * onboarding must not block on it. The agent persists the suggestion stack +
 * optimized sibling itself; we don't await a body.
 */
async function triggerResumeOptimize(
  userId: string,
  resumeId: string,
  traceId?: string,
  requestId?: string,
): Promise<void> {
  try {
    const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/resume/optimize`;
    const resp = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-user-id": userId,
        // W4.1: keep the trace alive across the fire-and-forget hop so
        // a later support investigation can follow it.
        ...(traceId ? { "X-Trace-Id": traceId } : {}),
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      body: JSON.stringify({ base_resume_id: resumeId }),
    });
    if (!resp.ok) {
      console.warn(
        `[resume] optimize chain returned ${resp.status} for resume ${resumeId}`,
      );
    }
  } catch (err) {
    console.warn(`[resume] optimize chain failed for resume ${resumeId}:`, err);
  }
}

/** Shape returned to the client when a parse job finishes. */
interface ParseJobResult {
  resume: JsonResume;
  saved: boolean;
  resumeId?: string;
  warnings: string[];
  usedFallback: boolean;
  meta: { model: string; costCents: number };
}

// POST /api/resumes/parse-async — START an asynchronous parse and return a job
// id immediately (202). This is the key onboarding-UX change: the client no
// longer blocks on the LLM. It uploads → enters the workspace → polls
// GET /parse/:jobId while the parse runs in the background. The parse never
// fabricates — on LLM failure the job ends "failed" with an honest message.
app.post("/parse-async", parseAsyncLimiter, validateBody(ParseResumeAsyncSchema), async (c) => {
  const userId = c.get("userId");
  const { text, markdown, save, sourceFileId } = c.get(
    "validatedBody",
  ) as ParseResumeAsync;
  // Capture the request-scoped trace + request ids before the worker
  // detaches. We thread them into the fire-and-forget optimize chain so
  // the agent's structlog binding keeps the same id (W4.1).
  const traceId = c.get("traceId");
  const requestId = c.get("requestId");
  // Pin the user's UI locale at request time and close over it. The async
  // worker runs after we've returned the 202, so by the time it persists
  // the résumé there's no Context to ask any more — but the canonical
  // markdown still needs to be rendered in the user's language.
  const locale = resolveLocale(c);
  // Prefer the Markdown middle state (richer structure → better parse); fall
  // back to raw text. The upload route already produced Markdown for files.
  const sourceText = (markdown ?? text ?? "").trim();

  const job = await createJob<ParseJobResult>(userId, "resume-parse");

  // Fire-and-forget: the request returns now; the worker updates the job in
  // Redis as it progresses. Bun's long-lived process keeps this promise alive.
  void runJob<ParseJobResult>(job.id, async (step) => {
    await step("parsing");
    const parsed = await parseResumeText(sourceText);
    let saved = false;
    let resumeId: string | undefined;
    if (save) {
      // Always persist — even when AI parsing failed, the raw text is the user's
      // v1 base. Warnings ride along so the UI can prompt the user to fill gaps.
      const row = await saveBaseResume(userId, parsed, sourceFileId, locale);
      saved = true;
      resumeId = row.id as string;
      // Chain an AI optimize pass (design §6.2): the original is now saved, so
      // kick off a no-JD best-practice pass in the agent layer. Fire-and-forget
      // — the optimized sibling + suggestions surface asynchronously in the dock
      // and studio; a failure here never blocks onboarding. Only chain when the
      // parse actually produced structure (a fallback raw-text v1 has nothing to
      // optimize yet).
      if (!parsed.usedFallback && (resumeId as string)) {
        void triggerResumeOptimize(userId, resumeId as string, traceId, requestId);
      }
    }
    return {
      resume: parsed.resume,
      saved,
      resumeId,
      warnings: parsed.warnings,
      usedFallback: parsed.usedFallback,
      meta: parsed.meta,
    };
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
    // is safe here; limit/offset stay bound parameters. track/derived_from
    // (migration 017) let the studio split versions into Original / Optimized /
    // Tailored rails and draw the derivation chain.
    `SELECT id, version, is_base, tailored_for_job, track, derived_from,
            source_file_id, created_at FROM resumes
     WHERE user_id = $1 ORDER BY ${sort} ${order} LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return c.json(paginated(result.rows, total, { limit, offset }));
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const resume = await requireOwnership("resumes", id, userId);
  return c.json({ resume: unwrapResumeRow(resume, resolveLocale(c)) });
});

app.put("/:id", validateBody(UpdateResumeSchema), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id")!; // present by route definition
  const { content, expectedVersion } = c.get("validatedBody") as UpdateResume;
  // ?mode=draft → overwrite content at the same version (autosave path,
  // edit/save design §1 R-1). Snapshot path (omitted / ?mode=snapshot) keeps
  // historical behaviour: bump version on every write so the timeline grows.
  // Either way we keep the expectedVersion guard so a parallel writer still
  // wins a race and we 409 here cleanly (§5 reconcile UX hangs on this).
  const mode = c.req.query("mode") === "draft" ? "draft" : "snapshot";

  // Hand-edits flow through this route. Preserve the wrapper shape if the row
  // already has one (raw text + warnings shouldn't be silently dropped when a
  // user tweaks a field), otherwise write the JsonResume verbatim.
  const existing = await query<{ content: unknown }>(
    "SELECT content FROM resumes WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  // When the row already uses the envelope shape, keep raw/source/warnings
  // intact but regenerate `markdown` from the new `parsed` so the main track
  // stays in sync (design §11.3 — both come from the same parse on every write).
  const wrapped = isWrappedResume(existing.rows[0]?.content)
    ? {
        ...(existing.rows[0].content as Record<string, unknown>),
        parsed: content,
        markdown: jsonResumeToMarkdown(content, { locale: resolveLocale(c) }),
        parsedAt: new Date().toISOString(),
      }
    : content;

  const sql =
    mode === "draft"
      ? `UPDATE resumes SET content = $1
         WHERE id = $2 AND user_id = $3 AND version = $4
         RETURNING id, content, version, is_base, created_at`
      : `UPDATE resumes SET content = $1, version = version + 1
         WHERE id = $2 AND user_id = $3 AND version = $4
         RETURNING id, content, version, is_base, created_at`;
  const result = await query(sql, [JSON.stringify(wrapped), id, userId, expectedVersion]);
  if (result.rows.length === 0) {
    // Either the row isn't ours/absent, or the version moved under us.
    await requireOwnership("resumes", id, userId, "id"); // throws NotFound if not owned
    throw new ConflictError("Resume version conflict — reload and retry");
  }
  // Echo `mode` so the client status chip can say "Draft saved" vs "Saved as
  // v4" without comparing version numbers — that's brittle when other tabs
  // race the same row.
  return c.json({ resume: unwrapResumeRow(result.rows[0], resolveLocale(c)), mode });
});

/** True when `content` is the new wrapper shape (parse output + raw text). */
function isWrappedResume(content: unknown): content is {
  raw: string;
  parsed: JsonResume;
  // Optional Markdown main track (design §11.3). Older rows predate this and
  // get a fallback render at unwrap time so the front-end never sees an
  // undefined field on a wrapped résumé.
  markdown?: string;
  warnings?: string[];
  parsedAt?: string;
  source?: {
    fileId: string;
    fileName: string;
    mime: string;
    sizeBytes: number;
  };
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
 *  metadata available as `_raw / _markdown / _warnings / _parsedAt / _source`.
 *  `_markdown` is the canonical GFM main track (§11.3) the front-end renders
 *  by default; if a legacy row pre-dates the dual-format envelope we re-render
 *  it on read so the client never has to do JSON-to-MD itself. */
function unwrapResumeRow(
  row: Record<string, unknown>,
  locale: "en" | "zh" = "en",
): Record<string, unknown> {
  if (!isWrappedResume(row.content)) return row;
  const { raw, parsed, markdown, warnings, parsedAt, source } = row.content;
  // Prefer the persisted markdown — it was rendered in the writer's locale
  // (see the create / parse / put routes above). Only re-render when the row
  // predates the envelope; then we use the *reader's* locale so a zh user
  // sees zh chrome even on a legacy row.
  const md = markdown && markdown.length > 0 ? markdown : jsonResumeToMarkdown(parsed, { locale });
  return {
    ...row,
    content: {
      ...parsed,
      _raw: raw,
      _markdown: md,
      _warnings: warnings ?? [],
      _parsedAt: parsedAt ?? null,
      ...(source ? { _source: source } : {}),
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

// ─── Résumé export ────────────────────────────────────────────────────────
//
// GET /:id/export?format=md|json|pdf|docx
//
// One endpoint, four formats. The canonical Markdown (jsonResumeToMarkdown)
// is the source of truth for every output: pdf and docx are downstream of
// the same string. That equivalence is the "what you see = what you get"
// guarantee — the preview, the print, the PDF, the DOCX all share one body.
//
// Auth + ownership are required (caller must own the résumé). The endpoint
// streams the bytes back with Content-Disposition: attachment so the browser
// triggers its native download UX.
app.get("/:id/export", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const formatParam = c.req.query("format") ?? "md";
  if (!isExportFormat(formatParam)) {
    throw new ValidationError(
      `Unsupported export format: ${formatParam}. Use md, json, pdf, or docx.`,
    );
  }
  const format: ExportFormat = formatParam;

  const row = await requireOwnership(
    "resumes",
    id,
    userId,
    "id, content, version",
  );
  const unwrapped = unwrapResumeRow(row, resolveLocale(c));
  // unwrapResumeRow flattens the envelope so content has _markdown/_raw/_source
  // alongside the JSON Resume fields. We need the strict JSON Resume shape for
  // export (no underscore-prefixed metadata sneaking into JSON output), and
  // the canonical _markdown for downstream pdf/docx render — pull them both
  // out cleanly here.
  const content = (unwrapped.content ?? {}) as Record<string, unknown>;
  const { _markdown, _raw, _warnings, _parsedAt, _source, ...parsed } = content as any;
  void _raw;
  void _warnings;
  void _parsedAt;
  void _source;

  const version = unwrapped.version ?? row.version ?? 1;
  const versionLabel = `v${version}`;
  const filename = exportFilename(parsed, versionLabel, format);

  switch (format) {
    case "md": {
      const md =
        typeof _markdown === "string" && _markdown.length > 0
          ? _markdown
          : exportMarkdown(parsed, resolveLocale(c));
      return new Response(md, {
        status: 200,
        headers: {
          "content-type": EXPORT_MIME.md,
          "content-disposition": attachmentHeader(filename),
        },
      });
    }
    case "json": {
      const body = exportJson(parsed);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": EXPORT_MIME.json,
          "content-disposition": attachmentHeader(filename),
        },
      });
    }
    case "pdf": {
      if (!(await pdfRenderAvailable())) {
        return c.json(
          {
            error: {
              code: "UPSTREAM",
              message:
                "PDF export requires Chromium on the server — try Markdown or JSON, or contact support.",
            },
          },
          501,
        );
      }
      const md =
        typeof _markdown === "string" && _markdown.length > 0
          ? _markdown
          : exportMarkdown(parsed, resolveLocale(c));
      const pdf = await renderResumePdf(md);
      // pdf is a Node Buffer; copy into a fresh ArrayBuffer so it lands as
      // a BodyInit lib.dom accepts. Cheap (a single allocation + memcpy).
      const ab = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
      return c.body(ab as ArrayBuffer, 200, {
        "content-type": EXPORT_MIME.pdf,
        "content-disposition": attachmentHeader(filename),
        "content-length": String(ab.byteLength),
      });
    }
    case "docx": {
      if (!(await docxExportAvailable())) {
        return c.json(
          {
            error: {
              code: "UPSTREAM",
              message:
                "DOCX export requires Pandoc on the server — try PDF or Markdown, or contact support.",
            },
          },
          501,
        );
      }
      const md =
        typeof _markdown === "string" && _markdown.length > 0
          ? _markdown
          : exportMarkdown(parsed, resolveLocale(c));
      const docx = await renderResumeDocx(md);
      if (!docx) {
        throw new UpstreamError(
          "DOCX conversion failed",
          "pandoc returned a non-zero exit",
        );
      }
      const docxAb = docx.buffer.slice(
        docx.byteOffset,
        docx.byteOffset + docx.byteLength,
      );
      return c.body(docxAb as ArrayBuffer, 200, {
        "content-type": EXPORT_MIME.docx,
        "content-disposition": attachmentHeader(filename),
        "content-length": String(docxAb.byteLength),
      });
    }
  }
});

/**
 * RFC 6266 attachment header that supports non-ASCII filenames. We supply
 * BOTH an ASCII fallback (`filename=…`) and a UTF-8 form (`filename*=…`) so
 * a name like "Iris Park" survives transit while a user with CJK characters
 * still gets a usable native filename in supporting browsers.
 */
function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ─── Résumé publish (read-only short link) ────────────────────────────────
//
// POST   /:id/publish    create/refresh a publish_token (rate-limited)
// DELETE /:id/publish    revoke (publish_token → NULL, link 404s immediately)
//
// The token is generated server-side (crypto.randomBytes(16).toString('hex'))
// so the client can't pick a vanity URL. Re-publishing rotates the token —
// old links die, the freshly-issued link replaces them. published_at is
// only ever advanced forward, kept for the audit trail.
//
// Public read path lives in routes/public-resumes.ts (no auth, no PII leak —
// just the JSON Resume content for the published version).
const publishLimiter = rateLimit({
  scope: "resume_publish",
  limit: 5,
  windowSeconds: 60,
});

app.post("/:id/publish", publishLimiter, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id")!; // present by route definition
  await requireOwnership("resumes", id, userId, "id"); // 404 if not owned
  const token = randomBytes(16).toString("hex");
  const result = await query<{
    publish_token: string;
    published_at: string;
  }>(
    `UPDATE resumes
       SET publish_token = $1, published_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING publish_token, published_at`,
    [token, id, userId],
  );
  if (result.rows.length === 0) throw new NotFoundError("Resume not found");
  const { publish_token, published_at } = result.rows[0];
  return c.json({
    publishToken: publish_token,
    publishedAt: published_at,
    publicUrl: `/r/${publish_token}`,
  });
});

app.delete("/:id/publish", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await requireOwnership("resumes", id, userId, "id"); // 404 if not owned
  await query(
    "UPDATE resumes SET publish_token = NULL WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
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

// ── Dual-track suggestion stack (migration 017 / design §6) ──────────────

// GET /:id/suggestions — the AI suggestion stack for a résumé. Read straight
// from PG (no LLM); the studio + dock render these as accept/reject cards.
// ?status= filters (default: proposed, i.e. things still awaiting a decision).
app.get("/:id/suggestions", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  // Ownership: a suggestion is only returned when its source résumé belongs to
  // the caller. We scope by both the suggestion's user_id and the résumé id.
  const status = c.req.query("status") ?? "proposed";
  const rows = await query(
    `SELECT id, bullet_stable_id, section, change_type, before_text,
            after_text, rationale, risk_level, status, proposed_by, proposed_at
       FROM resume_suggestions
      WHERE user_id = $1 AND source_resume_id = $2 AND status = $3
      ORDER BY proposed_at ASC`,
    [userId, id, status],
  );
  return c.json({ suggestions: rows.rows });
});

// POST /:id/bullet-edit — vibe chat on ONE bullet (design §6.3 [Discuss]).
// Proxies to the agent's propose_bullet_edit, which returns a single proposed
// suggestion the dock renders as a fresh suggestion card.
app.post("/:id/bullet-edit", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    bulletStableId?: string;
    instruction?: string;
  };
  if (!body.bulletStableId || !body.instruction) {
    throw new ConflictError("bulletStableId and instruction are required");
  }
  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/resume/propose-bullet-edit`;
  const beTraceId = c.get("traceId");
  const beRequestId = c.get("requestId");
  const resp = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relay-user-id": userId,
      // W4.1: forward trace headers so the agent's structlog binding
      // gets the same id the gateway used.
      ...(beTraceId ? { "X-Trace-Id": beTraceId } : {}),
      ...(beRequestId ? { "X-Request-Id": beRequestId } : {}),
    },
    body: JSON.stringify({
      resume_id: id,
      bullet_stable_id: body.bulletStableId,
      instruction: body.instruction,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new UpstreamError(
      `agent propose-bullet-edit returned ${resp.status}`,
      text.slice(0, 500),
    );
  }
  return c.json(await resp.json());
});

// POST /suggestions/:sid/decision — accept or reject one suggestion. Proxies to
// the agent layer, which (on accept) materializes it into a new optimized
// version under the fabrication guard. Kept thin: the agent owns the write.
app.post("/suggestions/:sid/decision", async (c) => {
  const userId = c.get("userId");
  const sid = c.req.param("sid");
  const body = (await c.req.json().catch(() => ({}))) as {
    decision?: string;
    decidedVia?: string;
  };
  if (body.decision !== "accept" && body.decision !== "reject") {
    throw new ConflictError("decision must be 'accept' or 'reject'");
  }
  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/resume/suggestions/${sid}/decision`;
  const decTraceId = c.get("traceId");
  const decRequestId = c.get("requestId");
  const resp = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relay-user-id": userId,
      // W4.1: forward trace headers.
      ...(decTraceId ? { "X-Trace-Id": decTraceId } : {}),
      ...(decRequestId ? { "X-Request-Id": decRequestId } : {}),
    },
    body: JSON.stringify({
      decision: body.decision,
      decided_via: body.decidedVia ?? "dock_inline",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 404) throw new NotFoundError("Suggestion not found");
    throw new UpstreamError(
      `agent suggestion decision returned ${resp.status}`,
      text.slice(0, 500),
    );
  }
  return c.json(await resp.json());
});

export default app;
