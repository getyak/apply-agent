import { z } from "zod";

// Per-entity request schemas. Single source of truth for the shape of every
// mutating request body, mirroring the columns each route writes. Kept in one
// file (the surface is small) rather than a schemas/ dir; split later if it
// grows past ~400 lines. Wire via the `validate` middleware.

// ── Resumes ────────────────────────────────────────────────────────────────

/** JSON Resume content is a free-form object validated downstream by the agent. */
const resumeContent = z.record(z.string(), z.unknown());

export const CreateResumeSchema = z.object({
  content: resumeContent,
  isBase: z.boolean().optional(),
});

export const UpdateResumeSchema = z.object({
  content: resumeContent,
  // Optimistic-lock guard: the version the client believes it is editing.
  expectedVersion: z.number().int().nonnegative(),
});

export const OptimizeResumeSchema = z.object({
  jobDescription: z.string().max(20_000).optional(),
});

/**
 * Parse raw resume text → structured JSON Resume. `text` is the extracted
 * content (from an uploaded file via /api/files, or pasted directly). When
 * `save` is true the parsed result is persisted as the user's base resume.
 */
export const ParseResumeSchema = z.object({
  text: z.string().min(20, "Resume text is too short to parse").max(60_000),
  save: z.boolean().optional(),
  // Points back at the user_files row the parse came from, so the saved résumé
  // can carry source-file metadata for the "Source" chip in Resume Studio.
  // Optional: pasted text and tests still parse without an uploaded file.
  sourceFileId: z.string().uuid().optional(),
});

/**
 * Start an ASYNCHRONOUS parse. Same input as ParseResumeSchema, but the route
 * returns a job id immediately instead of blocking on the LLM — the client
 * enters the workspace and polls for the result. `markdown` carries the
 * pipeline's middle state when the upload step already produced it (so the
 * async worker skips re-extraction); otherwise `text` is used.
 */
export const ParseResumeAsyncSchema = z
  .object({
    text: z.string().max(60_000).optional(),
    markdown: z.string().max(120_000).optional(),
    save: z.boolean().optional(),
    // See ParseResumeSchema.sourceFileId.
    sourceFileId: z.string().uuid().optional(),
  })
  .refine((v) => (v.markdown ?? v.text ?? "").trim().length >= 20, {
    message: "Provide resume text or markdown of at least 20 characters",
  });

export const CustomizeResumeSchema = z.object({
  jobId: z.string().uuid(),
  jobDescription: z.string().max(20_000).optional(),
});

// ── Applications ─────────────────────────────────────────────────────────────

const APPLICATION_STATUSES = [
  "draft",
  "review",
  "submitted",
  "interview",
  "rejected",
  "offer",
] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);

const SUBMIT_CHANNELS = ["client_extension", "api", "manual", "email"] as const;

export const PrepareApplicationSchema = z.object({
  jobId: z.string().uuid(),
  resumeId: z.string().uuid().optional(),
  coverLetter: z.string().optional(),
  formAnswers: z.record(z.string(), z.unknown()).optional(),
});

// T3b: prepare-from-jd kicks the full delivery-loop saga in the Python
// agent layer. The TS gateway just forwards (it has the user's base résumé
// in PG, so we look it up here and pass the JSON Resume blob through to
// avoid the agent doing the SELECT twice).
export const PrepareFromJDSchema = z.object({
  jdUrl: z.string().url(),
  formFields: z.array(z.record(z.string(), z.unknown())).optional(),
  applicationId: z.string().uuid().optional(),
});

export const UpdateApplicationSchema = z
  .object({
    status: ApplicationStatusSchema.optional(),
    coverLetter: z.string().optional(),
    formAnswers: z.record(z.string(), z.unknown()).optional(),
    outcome: z.string().optional(),
    submittedVia: z.enum(SUBMIT_CHANNELS).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

// ── Interviews ───────────────────────────────────────────────────────────────

export const CreateInterviewSessionSchema = z.object({
  jobId: z.string().uuid().optional(),
  jobDescription: z.string().max(20_000).optional(),
});

export const AnswerInterviewSchema = z.object({
  answer: z.string().min(1).max(20_000),
});

// ── Users ────────────────────────────────────────────────────────────────────

/**
 * Profile preferences. Open-ended JSONB on the column, but the API accepts a
 * known shape so we can validate at the boundary and reject typos like
 * `targetRoles` vs `target_roles`. Unknown fields are rejected (strict) rather
 * than silently dropped so a misnamed key is loud, not lost.
 */
export const UserPreferencesSchema = z
  .object({
    targetRoles: z.array(z.string().min(1).max(100)).max(20).optional(),
    skills: z.array(z.string().min(1).max(60)).max(50).optional(),
    minSalary: z.number().int().nonnegative().max(10_000_000).optional(),
    locations: z.array(z.string().min(1).max(100)).max(20).optional(),
    remote: z.boolean().optional(),
    // Opt-in to the data flywheel (vantage-ui-mapping.md §3.5): after a
    // real interview is logged, anonymised questions feed
    // interview_question_pool. Defaults to undefined (= off) — explicit
    // user choice required, never silently enabled. Storage layer reads
    // `users.preferences->>'crowdsourceOptIn'` before any pool write.
    crowdsourceOptIn: z.boolean().optional(),
    // UI language preference (en/zh). Persisted so the chosen interface
    // language follows the user across devices/sessions, not just the local
    // NEXT_LOCALE cookie. Mirror of web/src/i18n/config.ts LOCALES.
    language: z.enum(["en", "zh"]).optional(),
  })
  .strict();

export const UpdateUserSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    avatarUrl: z.string().url().max(2048).optional(),
    preferences: UserPreferencesSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

// ── Chat ─────────────────────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  message: z.string().min(1).max(20_000),
  sessionId: z.string().uuid().optional(),
});

export type CreateResume = z.infer<typeof CreateResumeSchema>;
export type UpdateResume = z.infer<typeof UpdateResumeSchema>;
export type ParseResume = z.infer<typeof ParseResumeSchema>;
export type ParseResumeAsync = z.infer<typeof ParseResumeAsyncSchema>;
export type PrepareApplication = z.infer<typeof PrepareApplicationSchema>;
export type PrepareFromJD = z.infer<typeof PrepareFromJDSchema>;
export type UpdateApplication = z.infer<typeof UpdateApplicationSchema>;
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;
