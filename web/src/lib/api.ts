"use client";

// API origin resolution lives in one place (api-base.ts) so the JSON client
// here and the SSE client in ask-stream.ts can never drift onto different
// bases / different env var names again.
import { API_BASE } from "./api-base";

// Token name is shared with web/src/middleware.ts; keep them in sync.
export const TOKEN_COOKIE = "vantage_token";
// 30 days — same horizon the API issues JWTs for.
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_COOKIE);
}

function writeCookie(token: string) {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  // The middleware reads this cookie at the edge for /app/* guards. We mirror
  // it from localStorage because the API client and historical code paths
  // still use localStorage; cookies are not httpOnly because the JS layer
  // also needs to read them — security parity, not regression.
  document.cookie =
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax${secure}`;
}

function clearCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${TOKEN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function setToken(token: string) {
  // Wipe any chat session that survived from a previous user logging in on
  // the same browser. Without this, a fresh login resumes the previous
  // user's Ask Vantage thread (their thread_id, their history) — silent
  // cross-account leakage. The thread is intentionally lifelong per user
  // (vantage-ui-mapping.md §1.2), so we only clear on the transition
  // boundary, not on every refresh.
  clearChatSessionId();
  localStorage.setItem(TOKEN_COOKIE, token);
  writeCookie(token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_COOKIE);
  clearCookie();
  // Sign-out paths (proxy reason=session_expired, settings → delete account,
  // layout me() failure) all funnel through here. Tying the chat session to
  // the token lifecycle means an orphan thread can't outlive the auth
  // boundary that produced it. signOut() in store.ts also calls
  // clearChatSessionId() directly for clarity — both calls are idempotent.
  clearChatSessionId();
}

// The Ask Vantage conversation is lifelong per user (vantage-ui-mapping.md §1.2):
// one session id we must survive reloads, otherwise each message after a refresh
// forks a brand-new session and fragments history. Mirror the token pattern but
// localStorage-only — the edge middleware never needs this, so no cookie.
const CHAT_SESSION_KEY = "vantage_chat_session";

export function getChatSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CHAT_SESSION_KEY);
}

export function setChatSessionId(sessionId: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(CHAT_SESSION_KEY, sessionId);
}

export function clearChatSessionId() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CHAT_SESSION_KEY);
}

// Default per-request ceiling. 15 s comfortably covers OpenRouter-backed
// LLM endpoints (parse / customize) but caps the offline / DNS-stall case
// so users don't watch a spinner for 30 s before getting any feedback.
// Callers can opt out with `signal` in options.
const DEFAULT_TIMEOUT_MS = 15000;

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Compose caller's AbortSignal with our timeout so either source can
  // cancel — needed because /api/ask/stream and other long-lived requests
  // bring their own controller.
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let signal = options.signal;
  if (!signal) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    signal = controller.signal;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal,
    });
  } catch (err) {
    if (timeoutId !== null) clearTimeout(timeoutId);
    // fetch() rejects with TypeError on transport failure (offline, DNS,
    // CORS preflight rejection) and AbortError on our timeout. Both surface
    // as ApiError(status=0) with a hint that points the user at the right
    // remedy instead of the raw "Failed to fetch" browser string.
    const aborted = err instanceof DOMException && err.name === "AbortError";
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new ApiError(0, "You appear to be offline. Reconnect and try again.");
    }
    if (aborted) {
      throw new ApiError(
        0,
        "The request took longer than expected. Check your connection and try again.",
      );
    }
    throw new ApiError(
      0,
      "Couldn't reach the server. Check your connection or try again in a moment.",
    );
  }
  if (timeoutId !== null) clearTimeout(timeoutId);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, extractErrorMessage(body));
  }

  return res.json();
}

/**
 * Pull a human-readable message out of an error body. The API uses two shapes:
 * the typed envelope `{ error: { code, message } }` (newer routes) and a plain
 * `{ error: "..." }` (auth/older routes). Handle both so we never surface
 * "[object Object]" to the user.
 */
function extractErrorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && "message" in e) {
      const m = (e as { message: unknown }).message;
      if (typeof m === "string") return m;
    }
  }
  return "Request failed";
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Offset-paginated list envelope returned by API routes that opt into
// `paginated(...)` on the server (see api/src/pagination.ts). Kept in sync
// with PaginatedEnvelope<T> so the client deserializes the same shape.
export interface PaginatedEnvelope<T> {
  data: T[];
  page: {
    total: number;
    limit: number;
    offset: number;
    nextOffset: number | null;
  };
}

// Profile preferences mirror api/src/schemas.ts UserPreferencesSchema. NB the
// API is camelCase + strict — unknown keys are rejected, so do NOT send
// snake_case (target_roles etc.). All fields optional on the wire.
export interface UserPreferences {
  targetRoles?: string[];
  skills?: string[];
  minSalary?: number;
  locations?: string[];
  remote?: boolean;
}

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  preferences: UserPreferences | null;
  created_at: string;
}

export const users = {
  // GET /api/auth/me — the canonical "who am I" read (there is no /api/users/me
  // GET; the users route only exposes PATCH + DELETE).
  getMe: () => api<{ user: UserRecord }>("/api/auth/me"),

  // PATCH /api/users/me — partial profile update. We only send `preferences`
  // here; the settings form has no display-name field yet.
  updateMe: (preferences: UserPreferences) =>
    api<{ user: UserRecord }>("/api/users/me", {
      method: "PATCH",
      body: JSON.stringify({ preferences }),
    }),

  // DELETE /api/users/me — GDPR erasure. Returns 204 (no JSON body), so don't
  // parse a response — the api() helper would choke on an empty body.
  deleteMe: async (): Promise<void> => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/users/me`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, extractErrorMessage(body));
    }
  },
};

export const auth = {
  register: (email: string, password: string, displayName?: string) =>
    api<{ token: string; user: { id: string; email: string; display_name: string } }>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, displayName }) },
    ),

  login: (email: string, password: string) =>
    api<{ token: string; user: { id: string; email: string; display_name: string } }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
    ),

  me: () =>
    api<{ user: { id: string; email: string; display_name: string; preferences: unknown } }>(
      "/api/auth/me",
    ),
};

/** Async parse job mirrored from the API's AsyncJob record. */
export interface ParseJob {
  id: string;
  type: string;
  status: "pending" | "extracting" | "markdown" | "parsing" | "done" | "failed";
  progress: number;
  result?: {
    resume: object;
    saved: boolean;
    resumeId?: string;
    meta: { model: string; costCents: number };
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const resumes = {
  create: (content: object, isBase = true) =>
    api<{ resume: { id: string; version: number; content: object } }>(
      "/api/resumes",
      { method: "POST", body: JSON.stringify({ content, isBase }) },
    ),

  // Parse raw resume text → structured JSON Resume via the LLM. `save:true`
  // persists it as the base resume in one call. This is the real onboarding
  // path — no hardcoded resume.
  parse: (text: string, save = false) =>
    api<{
      resume: object;
      saved: boolean;
      meta?: { model: string; costCents: number };
    }>("/api/resumes/parse", {
      method: "POST",
      body: JSON.stringify({ text, save }),
    }),

  // Start an ASYNCHRONOUS parse: returns a job id immediately so the UI can
  // enter the workspace and poll, instead of blocking on the LLM. Prefer the
  // Markdown middle state (richer structure) when the upload produced it.
  parseAsync: (input: { text?: string; markdown?: string; save?: boolean }) =>
    api<{ job: ParseJob }>("/api/resumes/parse-async", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Poll an async parse job until status is "done" (result present) or
  // "failed" (error present).
  parseStatus: (jobId: string) =>
    api<{ job: ParseJob }>(`/api/resumes/parse/${jobId}`),

  list: () =>
    api<PaginatedEnvelope<{ id: string; version: number; is_base: boolean; created_at: string }>>(
      "/api/resumes",
    ),

  get: (id: string) =>
    api<{ resume: { id: string; content: object; version: number } }>(
      `/api/resumes/${id}`,
    ),
};

export interface UploadResult {
  file: { id: string; filename: string; sizeBytes: number; kind: string } | null;
  stored: boolean;
  /** Structured Markdown — the canonical middle state for async parse. */
  markdown: string;
  /** Extracted plain text, ready to hand to resumes.parse() (mirrors markdown). */
  text: string;
  kind: "pdf" | "docx" | "text";
}

export const files = {
  // Multipart upload of a resume file. Bypasses the JSON api() helper because
  // the body is FormData (the browser sets the multipart boundary itself — we
  // must NOT set Content-Type manually).
  upload: async (file: File): Promise<UploadResult> => {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/api/files`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error?.message || body.error || "Upload failed");
    }
    return res.json();
  },
};

export const jobs = {
  list: (params?: { search?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return api<{ jobs: Array<{ id: string; company: string; role_title: string; url: string; parsed: object; posted_date: string }> }>(
      `/api/jobs${query ? `?${query}` : ""}`,
    );
  },

  get: (id: string) =>
    api<{ job: { id: string; company: string; role_title: string; jd_text: string; parsed: object } }>(
      `/api/jobs/${id}`,
    ),

  match: (jobId: string) =>
    api<{ match: { score: number; matchedSkills: string[]; missingSkills: string[] } }>(
      `/api/jobs/${jobId}/match`,
      { method: "POST" },
    ),
};

export const applications = {
  prepare: (jobId: string, resumeId: string, coverLetter?: string) =>
    api<{ application: { id: string; status: string } }>(
      "/api/applications/prepare",
      { method: "POST", body: JSON.stringify({ jobId, resumeId, coverLetter }) },
    ),

  list: (status?: string) => {
    const qs = status ? `?status=${status}` : "";
    return api<
      PaginatedEnvelope<{
        id: string;
        status: string;
        company: string;
        role_title: string;
        cover_letter?: string;
        submitted_at?: string;
        created_at: string;
      }>
    >(`/api/applications${qs}`);
  },

  update: (id: string, data: { status?: string; outcome?: string; coverLetter?: string }) =>
    api<{ application: { id: string; status: string } }>(
      `/api/applications/${id}`,
      { method: "PATCH", body: JSON.stringify(data) },
    ),
};

export const interviews = {
  createSession: (jobId?: string) =>
    api<{ session: { id: string }; questions: Array<{ id: string; question_text: string; category: string }> }>(
      "/api/interviews/session",
      { method: "POST", body: JSON.stringify({ jobId }) },
    ),

  answer: (sessionId: string, questionId: string, answer: string) =>
    api<{ question: object; feedback: { text: string; rating: number } }>(
      `/api/interviews/${sessionId}/answer`,
      { method: "POST", body: JSON.stringify({ questionId, answer }) },
    ),

  list: () =>
    api<{ sessions: Array<{ id: string; company: string; role_title: string; created_at: string }> }>(
      "/api/interviews",
    ),
};

export const chat = {
  send: (message: string, sessionId?: string) =>
    api<{ sessionId: string; reply: { content: string; metadata: { agent: string } } }>(
      "/api/chat/send",
      { method: "POST", body: JSON.stringify({ sessionId, message }) },
    ),

  sessions: () =>
    api<{ sessions: Array<{ id: string; title: string; created_at: string }> }>(
      "/api/chat/sessions",
    ),

  messages: (sessionId: string) =>
    api<{ messages: Array<{ id: string; role: string; content: string; created_at: string }> }>(
      `/api/chat/sessions/${sessionId}/messages`,
    ),
};

export const trends = {
  today: () =>
    api<{ snapshot: { totalJobs: number; newJobsThisWeek: number; topSkills: Array<{ skill: string; count: number }>; topRoles: Array<{ role_title: string; count: number }> } }>(
      "/api/trends/today",
    ),

  personalized: () =>
    api<{ personalized: { yourSkills: string[]; trendingSkills: string[]; youHave: string[]; youNeed: string[]; insight: string } }>(
      "/api/trends/personalized",
    ),
};
