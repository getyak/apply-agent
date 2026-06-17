// AsyncJob — a minimal Redis-backed primitive for "slow LLM work that must not
// block the UI". The resume parse is its first consumer, but the same shape
// fits every long task in Relay: JD-tailored resume, cover-letter generation,
// interview-question generation, application-package prep. They are all
// "AI does the work, the user reviews after" (vision principle 4) — so none of
// them should make the user stare at a spinner.
//
// Design (deliberately small — this is NOT a job queue framework; BullMQ is the
// Phase-2 story, see infra/CLAUDE.md):
//   - createJob → writes a pending record to Redis, returns immediately
//   - runJob    → fire-and-forget executor; updates status/progress as it goes
//   - getJob    → owner-scoped read for the client to poll
//
// State lives in Redis only: it is transient task state, not an audit record.
// Once a parse finishes the real resume is already in Postgres, so the job
// itself is disposable (1h TTL). Ownership is encoded in the record and checked
// on read so one user can never poll another's job.

import redis from "./redis";

/** Lifecycle of an async job. Granular enough to drive a real progress bar. */
export type JobStatus =
  | "pending"
  | "extracting"
  | "markdown"
  | "parsing"
  | "done"
  | "failed";

/** Coarse progress percentage per status, so the client needn't hardcode it. */
const PROGRESS: Record<JobStatus, number> = {
  pending: 5,
  extracting: 25,
  markdown: 45,
  parsing: 70,
  done: 100,
  failed: 100,
};

export interface AsyncJob<R = unknown> {
  id: string;
  userId: string;
  /** Discriminator so one poll endpoint can serve many job kinds. */
  type: string;
  status: JobStatus;
  /** 0–100, derived from status. */
  progress: number;
  /** Present only when status === "done". */
  result?: R;
  /** Human-readable failure reason when status === "failed". */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const TTL_SECONDS = 60 * 60; // 1h — long enough to poll, short enough to self-clean.

function key(jobId: string): string {
  return `job:${jobId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Create a pending job and persist it. Returns the record so the caller can
 * hand the id straight back to the client (which then polls getJob).
 */
export async function createJob<R = unknown>(
  userId: string,
  type: string,
): Promise<AsyncJob<R>> {
  const ts = nowIso();
  const job: AsyncJob<R> = {
    id: crypto.randomUUID(),
    userId,
    type,
    status: "pending",
    progress: PROGRESS.pending,
    createdAt: ts,
    updatedAt: ts,
  };
  await redis.set(key(job.id), JSON.stringify(job), "EX", TTL_SECONDS);
  return job;
}

/** Read a job, scoped to its owner. Returns null when absent or not the owner. */
export async function getJob<R = unknown>(
  jobId: string,
  userId: string,
): Promise<AsyncJob<R> | null> {
  const raw = await redis.get(key(jobId));
  if (!raw) return null;
  let job: AsyncJob<R>;
  try {
    job = JSON.parse(raw) as AsyncJob<R>;
  } catch {
    return null; // corrupt record — treat as absent
  }
  // Enumeration-safe: a non-owner gets the same "not found" as a missing job.
  if (job.userId !== userId) return null;
  return job;
}

/** Internal: merge a patch into the stored job, refreshing the TTL. */
async function patchJob(
  jobId: string,
  patch: Partial<Pick<AsyncJob, "status" | "result" | "error">>,
): Promise<void> {
  const raw = await redis.get(key(jobId));
  if (!raw) return; // expired/cancelled mid-run — drop the update silently
  let job: AsyncJob;
  try {
    job = JSON.parse(raw) as AsyncJob;
  } catch {
    return;
  }
  if (patch.status) {
    job.status = patch.status;
    job.progress = PROGRESS[patch.status];
  }
  if (patch.result !== undefined) job.result = patch.result;
  if (patch.error !== undefined) job.error = patch.error;
  job.updatedAt = nowIso();
  await redis.set(key(jobId), JSON.stringify(job), "EX", TTL_SECONDS);
}

/**
 * The executor a job runner receives. It reports progress by calling `step`
 * and returns the final result. Throwing marks the job failed with the error
 * message (never swallowed — failures are surfaced to the polling client).
 */
export type JobExecutor<R> = (
  step: (status: Exclude<JobStatus, "pending" | "done" | "failed">) => Promise<void>,
) => Promise<R>;

/**
 * Run a job's work to completion, updating its Redis record as it progresses.
 * Intended to be fired and not awaited by the request handler:
 *
 *   const job = await createJob(userId, "resume-parse");
 *   void runJob(job.id, async (step) => { ... });   // returns 202 immediately
 *
 * Bun's server process is long-lived, so the detached promise keeps running
 * after the originating request returns (MVP single-instance; Phase 2 moves to
 * a real worker). Errors are caught and recorded — they must not crash the
 * process or vanish.
 */
export async function runJob<R>(
  jobId: string,
  executor: JobExecutor<R>,
): Promise<void> {
  try {
    const result = await executor((status) => patchJob(jobId, { status }));
    await patchJob(jobId, { status: "done", result });
  } catch (err) {
    await patchJob(jobId, {
      status: "failed",
      error: err instanceof Error ? err.message : "Job failed",
    });
  }
}
