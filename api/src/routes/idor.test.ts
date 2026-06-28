/**
 * SEC-009: IDOR boundary test matrix.
 *
 * Two users (A and B) are wired to in-memory stub DBs. User B attempts every
 * read/write verb on resources owned by User A. Every cross-user attempt MUST
 * return 404 — never 200 (data leak) and never 403 (existence leak).
 * Unauthenticated requests MUST return 401.
 *
 * Covered matrix (3 resources × verbs, plus unauthenticated guard):
 *   resumes     : GET /:id, PUT /:id, DELETE /:id
 *   applications: GET /:id, PATCH /:id
 *   files       : GET /:id/download
 *
 * The routes call `requireOwnership(table, id, userId, columns, queryFn)`.
 * We inject a fake queryFn via a module-level mock so no real PG is needed.
 */

import { describe, expect, it, mock, afterAll } from "bun:test";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { AppEnv } from "../types";
import { errorHandler } from "../errors";
import { config } from "../config";

// ─── In-memory DB stub ────────────────────────────────────────────────────────

const USER_A = "user-a-uuid";
const USER_B = "user-b-uuid";

const RESUME_ID = "resume-001";
const APP_ID = "app-001";
const FILE_ID = "file-001";

// Minimal rows for ownership checks — fields match what routes SELECT.
const RESUME_ROW = { id: RESUME_ID, user_id: USER_A, content: {}, version: 1, is_base: true, created_at: new Date().toISOString() };
const APP_ROW = { id: APP_ID, user_id: USER_A, status: "draft", job_id: null, cover_letter: null, form_answers: null };
const FILE_ROW = { id: FILE_ID, user_id: USER_A, storage_key: "user-a-uuid/resumes/originals/file-001.pdf", is_deleted: false };

// Track which owner context is active (swapped per describe block).
let activeOwnerId = USER_A;

/**
 * Fake query function — returns rows only when userId matches activeOwnerId.
 * A cross-user lookup returns empty rows, triggering NotFoundError → 404.
 */
async function stubQuery(text: string, params: unknown[]) {
  const [id, userId] = params as string[];

  // Version MAX used by resumes POST — not a cross-user path, just satisfy it.
  if (text.includes("COALESCE(MAX(version)")) {
    return { rows: [{ next_version: 2 }] };
  }
  // COUNT queries (list endpoints) — not in the IDOR matrix but guard anyway.
  if (text.includes("COUNT(*)")) {
    return { rows: [{ total: 0 }] };
  }

  if (userId !== activeOwnerId) return { rows: [] };

  if (text.includes("FROM resumes") && id === RESUME_ID) return { rows: [RESUME_ROW] };
  if (text.includes("FROM application_drafts") && id === APP_ID) return { rows: [APP_ROW] };
  if (text.includes("FROM user_files") && id === FILE_ID) return { rows: [FILE_ROW] };
  // DELETE statement (no RETURNING) — ownership already passed, just succeed.
  if (text.startsWith("DELETE")) return { rows: [] };
  // UPDATE for PATCH applications — ownership passed; return the updated row.
  if (text.startsWith("UPDATE application_drafts")) return { rows: [APP_ROW] };

  return { rows: [] };
}

// ─── Module mocking (must happen before importing routes) ────────────────────

mock.module("../db", () => ({ query: stubQuery }));

mock.module("../cache", () => ({
  cache: {
    getOrSet: async (_ns: string, _key: unknown[], fn: () => unknown) => fn(),
  },
}));

mock.module("../llm", () => ({
  llm: { available: false },
  LLMUnavailableError: class LLMUnavailableError extends Error {},
}));

mock.module("../storage", () => ({
  storage: { available: false, presign: () => null, put: async () => {} },
  StorageUnavailableError: class StorageUnavailableError extends Error {},
}));

mock.module("../extract", () => ({
  classifyKind: () => null,
  ExtractionError: class ExtractionError extends Error {},
}));

mock.module("../markdown", () => ({
  bytesToMarkdown: async () => ({ markdown: "" }),
}));

mock.module("../resume-parse", () => ({
  parseResumeText: async () => ({ resume: {}, meta: { model: "stub", costCents: 0 } }),
}));

mock.module("../jobs", () => ({
  createJob: async () => ({ id: "job-1", status: "pending" }),
  getJob: async () => null,
  runJob: async () => {},
}));

// ─── Import routes AFTER mocks ───────────────────────────────────────────────

const { default: resumeRoutes } = await import("./resumes");
const { default: applicationRoutes } = await import("./applications");
const { default: fileRoutes } = await import("./files");

const APP = new Hono<AppEnv>();
APP.route("/api/resumes", resumeRoutes);
APP.route("/api/applications", applicationRoutes);
APP.route("/api/files", fileRoutes);
APP.onError(errorHandler);

// ─── JWT helpers ─────────────────────────────────────────────────────────────

// Read the actual secret from config so the test works regardless of whether
// the .env file overrides the default "dev-secret-change-me".
const JWT_SECRET = new TextEncoder().encode(config.JWT_SECRET);

async function makeJwt(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function req(
  method: string,
  path: string,
  opts: { userId?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.userId) headers["Authorization"] = `Bearer ${await makeJwt(opts.userId)}`;
  if (opts.body) headers["Content-Type"] = "application/json";
  return APP.request(path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SEC-009 IDOR — unauthenticated → 401", () => {
  it("GET /api/resumes/:id", async () => {
    expect((await req("GET", `/api/resumes/${RESUME_ID}`)).status).toBe(401);
  });
  it("PUT /api/resumes/:id", async () => {
    expect(
      (await req("PUT", `/api/resumes/${RESUME_ID}`, { body: { content: {}, expectedVersion: 1 } }))
        .status,
    ).toBe(401);
  });
  it("DELETE /api/resumes/:id", async () => {
    expect((await req("DELETE", `/api/resumes/${RESUME_ID}`)).status).toBe(401);
  });
  it("GET /api/applications/:id", async () => {
    expect((await req("GET", `/api/applications/${APP_ID}`)).status).toBe(401);
  });
  it("PATCH /api/applications/:id", async () => {
    expect(
      (await req("PATCH", `/api/applications/${APP_ID}`, { body: { status: "submitted" } }))
        .status,
    ).toBe(401);
  });
  it("GET /api/files/:id/download", async () => {
    expect((await req("GET", `/api/files/${FILE_ID}/download`)).status).toBe(401);
  });
});

describe("SEC-009 IDOR — cross-user (User B on User A resources) → 404 only", () => {
  // activeOwnerId stays USER_A: stub returns rows only for A, empty for B.

  it("GET /api/resumes/:id → 404 not 200/403", async () => {
    const res = await req("GET", `/api/resumes/${RESUME_ID}`, { userId: USER_B });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("PUT /api/resumes/:id → 404", async () => {
    const res = await req("PUT", `/api/resumes/${RESUME_ID}`, {
      userId: USER_B,
      body: { content: { basics: { name: "attacker" } }, expectedVersion: 1 },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/resumes/:id → 404", async () => {
    const res = await req("DELETE", `/api/resumes/${RESUME_ID}`, { userId: USER_B });
    expect(res.status).toBe(404);
  });

  it("GET /api/applications/:id → 404", async () => {
    const res = await req("GET", `/api/applications/${APP_ID}`, { userId: USER_B });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/applications/:id → 404", async () => {
    const res = await req("PATCH", `/api/applications/${APP_ID}`, {
      userId: USER_B,
      body: { status: "submitted" },
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/files/:id/download → 404", async () => {
    const res = await req("GET", `/api/files/${FILE_ID}/download`, { userId: USER_B });
    expect(res.status).toBe(404);
  });
});

describe("SEC-009 IDOR — same-user (User A on own resources) → not 404", () => {
  // Sanity: the guard must not block the legitimate owner.

  it("GET /api/resumes/:id by owner → 200", async () => {
    activeOwnerId = USER_A;
    expect((await req("GET", `/api/resumes/${RESUME_ID}`, { userId: USER_A })).status).toBe(200);
  });

  it("DELETE /api/resumes/:id by owner → 200", async () => {
    activeOwnerId = USER_A;
    expect((await req("DELETE", `/api/resumes/${RESUME_ID}`, { userId: USER_A })).status).toBe(200);
  });

  it("GET /api/applications/:id by owner → 200", async () => {
    activeOwnerId = USER_A;
    expect((await req("GET", `/api/applications/${APP_ID}`, { userId: USER_A })).status).toBe(200);
  });
});

afterAll(() => {
  activeOwnerId = USER_A;
});
