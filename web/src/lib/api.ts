"use client";

// API origin resolution lives in one place (api-base.ts) so the JSON client
// here and the SSE client in ask-stream.ts can never drift onto different
// bases / different env var names again.
import { API_BASE } from "./api-base";
import { reportApiHealth } from "./health-store";
import { getClientLocale } from "../i18n/locale-client";

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

/**
 * Codes for which one safe retry helps:
 *   - DB_UNAVAILABLE / CACHE_UNAVAILABLE — gateway just restarted a pool
 *   - UPSTREAM_TIMEOUT — first attempt warmed a cold container
 * We retry only idempotent verbs (GET/HEAD). POST / PATCH / PUT / DELETE
 * are never auto-retried — duplicate mutations are worse than a clean
 * error the user explicitly retries.
 */
const RETRYABLE_CODES = new Set([
  "DB_UNAVAILABLE",
  "CACHE_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
]);

function isIdempotent(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD";
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  try {
    return await apiOnce<T>(path, options);
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code &&
      RETRYABLE_CODES.has(err.code) &&
      isIdempotent(options.method)
    ) {
      // Exponential backoff: server hinted via action.after (seconds);
      // we cap at 2 s so the user isn't watching a frozen UI for 5s.
      const hintMs =
        err.action?.kind === "retry" && err.action.after
          ? Math.min(err.action.after * 1000, 2000)
          : 600;
      await new Promise((r) => setTimeout(r, hintMs));
      return apiOnce<T>(path, options);
    }
    throw err;
  }
}

async function apiOnce<T>(path: string, options: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Stamp the user's UI locale on every API call. The Hono layer reads
    // X-Relay-Locale (api/src/locale.ts) and forwards it into résumé-markdown
    // rendering, the agents proxy, etc. — so chrome the server generates
    // (section titles, system messages) always matches the chrome the web
    // shell is rendering. Caller-supplied options.headers wins for the rare
    // case where a request needs to pin a different locale.
    "X-Relay-Locale": getClientLocale(),
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
    // CORS preflight rejection, or a local proxy / VPN dropping
    // localhost — the classic Clash / v2ray story) and AbortError on
    // our timeout. We branch on `navigator.onLine` to tell genuine
    // offline apart from "online but the request can't get through":
    //   - offline           → NETWORK_OFFLINE
    //   - online + timeout  → UPSTREAM_TIMEOUT
    //   - online + reject   → NETWORK_BLOCKED   (proxy/extension/CORS)
    const aborted = err instanceof DOMException && err.name === "AbortError";
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new ApiError(0, "You appear to be offline. Reconnect and try again.", {
        code: "NETWORK_OFFLINE",
        messageKey: "errors.network.offline",
      });
    }
    if (aborted) {
      throw new ApiError(
        0,
        "The request took longer than expected. Check your connection and try again.",
        { code: "UPSTREAM_TIMEOUT", messageKey: "errors.upstream.timeout" },
      );
    }
    throw new ApiError(
      0,
      "Couldn't reach the server. A proxy or VPN may be blocking localhost.",
      { code: "NETWORK_BLOCKED", messageKey: "errors.network.blocked" },
    );
  }
  if (timeoutId !== null) clearTimeout(timeoutId);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // Envelope v2 (docs/architecture/error-handling.md §2.1): extract
    // every field the server gave us, plus the trace/health headers so
    // callers can surface a Reference code and a global health banner
    // without re-parsing.
    const meta = { ...extractErrorMeta(body), ...readTraceHeaders(res) };
    if (meta.healthStatus === "degraded") {
      reportApiHealth("degraded", { code: meta.code, traceId: meta.traceId });
    }
    throw new ApiError(res.status, extractErrorMessage(body), meta);
  }

  // Clean 2xx clears the degraded flag — the world's healthy again.
  // (We're conservative: only happens when the gateway's response shape
  // looks normal, so an isolated 200 from a static endpoint can clear
  // a real outage. That's a feature: we don't want a stale banner.)
  if (res.headers.get("x-relay-health") !== "degraded") {
    reportApiHealth("ok");
  }

  return res.json();
}

/**
 * Pull X-Trace-Id / X-Request-Id / X-Relay-Health off the Response.
 * These are envelope v2 sidechannels: present on every response (not
 * just errors) so the global health banner can light up on any 503,
 * and the support copy can quote a trace even if the JSON body was
 * stripped by a proxy.
 */
function readTraceHeaders(res: Response): {
  traceId?: string;
  requestId?: string;
  healthStatus?: "ok" | "degraded";
} {
  const out: {
    traceId?: string;
    requestId?: string;
    healthStatus?: "ok" | "degraded";
  } = {};
  const tid = res.headers.get("x-trace-id");
  if (tid) out.traceId = tid;
  const rid = res.headers.get("x-request-id");
  if (rid) out.requestId = rid;
  const h = res.headers.get("x-relay-health");
  if (h === "degraded") out.healthStatus = "degraded";
  return out;
}

/** True when an error came from fetch's transport layer (offline, DNS,
 *  CORS preflight, our 15s timeout) rather than an HTTP status. UI can
 *  use this to decide between "retry" and "fix your input" affordances. */
export function isNetworkError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 0;
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

// envelope v2 — see docs/architecture/error-handling.md §2.1.
// Tolerant parser: accepts the v2 shape from the gateway alongside any
// legacy `{ error: "string" }` shape that might still be floating
// around (older Python routes, third-party integrations). Missing
// fields become undefined; the consumer's resolver fills them in.
export type ErrorAction =
  | { kind: "retry"; after?: number }
  | { kind: "reauth"; redirect: string }
  | { kind: "contact"; channel: "email" | "in-app" }
  | { kind: "wait"; until: string; reason: string }
  | {
      kind: "fix-input";
      fields: { name: string; msg: string }[];
    }
  | { kind: "none" };

interface ErrorMeta {
  code?: string;
  messageKey?: string;
  traceId?: string;
  traceCode?: string;
  requestId?: string;
  timestamp?: string;
  action?: ErrorAction;
  details?: unknown;
}

function extractErrorMeta(body: unknown): ErrorMeta {
  if (!body || typeof body !== "object" || !("error" in body)) return {};
  const e = (body as { error: unknown }).error;
  if (!e || typeof e !== "object") return {};
  const obj = e as Record<string, unknown>;
  const out: ErrorMeta = {};
  if (typeof obj.code === "string") out.code = obj.code;
  if (typeof obj.messageKey === "string") out.messageKey = obj.messageKey;
  // Accept both camelCase (Bun gateway) and snake_case (older Python paths).
  const tid =
    typeof obj.traceId === "string"
      ? obj.traceId
      : typeof obj.trace_id === "string"
        ? obj.trace_id
        : undefined;
  if (tid) out.traceId = tid;
  if (typeof obj.traceCode === "string") out.traceCode = obj.traceCode;
  const rid =
    typeof obj.requestId === "string"
      ? obj.requestId
      : typeof obj.request_id === "string"
        ? obj.request_id
        : undefined;
  if (rid) out.requestId = rid;
  if (typeof obj.timestamp === "string") out.timestamp = obj.timestamp;
  if (obj.details !== undefined) out.details = obj.details;
  if (obj.action && typeof obj.action === "object") {
    out.action = obj.action as ErrorAction;
  }
  return out;
}

/**
 * Derive the user-facing short code locally if the server didn't send
 * one. Mirror of api/src/errors.ts traceCodeFromTraceId so the same
 * traceId always renders the same code, regardless of which side
 * computes it.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function traceCodeFromTraceId(traceId: string): string {
  const hex = traceId.replace(/-/g, "").slice(0, 10);
  if (hex.length < 10) return "R-0000";
  const high = parseInt(hex.slice(0, 5), 16);
  const low = parseInt(hex.slice(5, 10), 16);
  const folded = high ^ low;
  let out = "";
  let n = folded;
  for (let i = 0; i < 4; i++) {
    out = CROCKFORD[n & 0x1f] + out;
    n = n >>> 5;
  }
  return `R-${out}`;
}

export class ApiError extends Error {
  // Envelope v2 fields; all optional so legacy `{ error: "string" }`
  // responses still hydrate a working error object.
  public code?: string;
  public messageKey?: string;
  public traceId?: string;
  public traceCode?: string;
  public requestId?: string;
  public timestamp?: string;
  public action?: ErrorAction;
  public details?: unknown;
  /**
   * "degraded" when the gateway flagged this response with
   * X-Relay-Health=degraded — drives the global HealthBanner. Absent
   * means "no opinion" (the banner stays in whatever state it's in;
   * a fresh "ok" only comes from a clean 2xx).
   */
  public healthStatus?: "ok" | "degraded";

  constructor(
    public status: number,
    message: string,
    meta?: ErrorMeta & { healthStatus?: "ok" | "degraded" },
  ) {
    super(message);
    this.name = "ApiError";
    if (meta?.code) this.code = meta.code;
    if (meta?.messageKey) this.messageKey = meta.messageKey;
    if (meta?.traceId) this.traceId = meta.traceId;
    // Compute traceCode lazily if the server didn't ship it (older
    // gateways pre-W1.2 don't, and the agents host gets W3.2 later).
    this.traceCode =
      meta?.traceCode ?? (meta?.traceId ? traceCodeFromTraceId(meta.traceId) : undefined);
    if (meta?.requestId) this.requestId = meta.requestId;
    if (meta?.timestamp) this.timestamp = meta.timestamp;
    if (meta?.action) this.action = meta.action;
    if (meta?.details !== undefined) this.details = meta.details;
    if (meta?.healthStatus) this.healthStatus = meta.healthStatus;
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
  /** Opt-in to anonymised question-pool donation (vantage-ui-mapping.md
   *  §3.5). false / undefined means we never write to
   *  interview_question_pool from this user. */
  crowdsourceOptIn?: boolean;
  /** Preferred UI language (en/zh). Persisted server-side so the choice
   *  follows the user across devices; the local NEXT_LOCALE cookie is the
   *  fast path, this is the durable source. */
  language?: "en" | "zh";
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
      throw new ApiError(
        res.status,
        extractErrorMessage(body),
        extractErrorMeta(body),
      );
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
  parseAsync: (input: {
    text?: string;
    markdown?: string;
    save?: boolean;
    // Optional UUID of the user_files row this parse came from. Threaded
    // through so the saved résumé can carry source-file metadata for the
    // "Source · resume.pdf" chip in Resume Studio.
    sourceFileId?: string;
  }) =>
    api<{ job: ParseJob }>("/api/resumes/parse-async", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Poll an async parse job until status is "done" (result present) or
  // "failed" (error present).
  parseStatus: (jobId: string) =>
    api<{ job: ParseJob }>(`/api/resumes/parse/${jobId}`),

  list: () =>
    api<
      PaginatedEnvelope<{
        id: string;
        version: number;
        is_base: boolean;
        // Dual-track model (migration 017): track splits the timeline into
        // Original / Optimized / Tailored rails; derived_from draws the chain.
        track: "original" | "optimized" | "tailored";
        derived_from: string | null;
        tailored_for_job: string | null;
        source_file_id: string | null;
        created_at: string;
      }>
    >("/api/resumes"),

  get: (id: string) =>
    api<{
      resume: {
        id: string;
        content: { _markdown?: string; [k: string]: unknown };
        version: number;
        is_base?: boolean;
        track?: "original" | "optimized" | "tailored";
        tailored_for_job?: string | null;
        // Publish state (migration 018). Both nullable: the résumé starts
        // unpublished, revoke sets publish_token back to NULL but keeps
        // published_at as an audit trail.
        publish_token?: string | null;
        published_at?: string | null;
      };
    }>(`/api/resumes/${id}`),

  /**
   * Hand-edit a résumé (inline studio writes go through this).
   *
   * - `mode: "draft"` overwrites content at the SAME row version — autosave
   *   uses this so the timeline doesn't grow per keystroke.
   * - `mode: "snapshot"` (default) bumps version — that's the user-visible
   *   "Save snapshot" / Cmd+S action.
   *
   * Both paths still gate on `expectedVersion`; a concurrent tab racing the
   * same row surfaces as 409 (`ConflictError`) for the §5 reconcile UX.
   * The response echoes `mode` so the status chip can branch without
   * comparing version numbers (racy across tabs).
   */
  update: (
    id: string,
    payload: { content: Record<string, unknown>; expectedVersion: number },
    options?: { mode?: "draft" | "snapshot" },
  ) =>
    api<{
      resume: {
        id: string;
        content: { _markdown?: string; [k: string]: unknown };
        version: number;
        is_base?: boolean;
      };
      mode: "draft" | "snapshot";
    }>(`/api/resumes/${id}${options?.mode === "draft" ? "?mode=draft" : ""}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  // The AI suggestion stack for a résumé (proposed by default). Read-only —
  // accept/reject goes through decideSuggestion.
  suggestions: (id: string, status = "proposed") =>
    api<{
      suggestions: Array<{
        id: string;
        bullet_stable_id: string | null;
        section: string | null;
        change_type: string;
        before_text: string;
        after_text: string;
        rationale: string | null;
        risk_level: "safe" | "needs_review" | "unsupported";
        status: string;
        proposed_by: string;
      }>;
    }>(`/api/resumes/${id}/suggestions?status=${encodeURIComponent(status)}`),

  // Accept or reject one suggestion. On accept the agent materializes it into
  // a new optimized version under the fabrication guard.
  decideSuggestion: (suggestionId: string, decision: "accept" | "reject", decidedVia = "studio_panel") =>
    api<{ ok: boolean; status: string; resume_id?: string; version?: number }>(
      `/api/resumes/suggestions/${suggestionId}/decision`,
      { method: "POST", body: JSON.stringify({ decision, decidedVia }) },
    ),

  // Vibe chat on ONE bullet (design §6.3 [Discuss]). Returns a single proposed
  // suggestion (or ok:false with a note when the edit can't be honored).
  bulletEdit: (resumeId: string, bulletStableId: string, instruction: string) =>
    api<{
      ok: boolean;
      note?: string | null;
      suggestion?: {
        id: string;
        bullet_stable_id: string | null;
        section: string | null;
        change_type: string;
        before_text: string;
        after_text: string;
        rationale: string | null;
        risk_level: "safe" | "needs_review" | "unsupported";
      };
    }>(`/api/resumes/${resumeId}/bullet-edit`, {
      method: "POST",
      body: JSON.stringify({ bulletStableId, instruction }),
    }),

  // ─── Export ─────────────────────────────────────────────────────────────
  // The export endpoint streams a download, so we don't go through api() —
  // it would try to res.json() the bytes. The drawer calls .download() which
  // attaches the Bearer token, parses Content-Disposition, and synthesises
  // an <a download> click. exportUrl() exists for legacy `window.location`
  // openers that don't need auth (none in the app today — public surfaces use
  // /api/public/r — but the helper is here for completeness).
  exportUrl: (resumeId: string, format: "md" | "json" | "pdf" | "docx") =>
    `${API_BASE}/api/resumes/${resumeId}/export?format=${format}`,

  download: async (
    resumeId: string,
    format: "md" | "json" | "pdf" | "docx",
  ): Promise<void> => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(
      `${API_BASE}/api/resumes/${resumeId}/export?format=${format}`,
      { headers },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(
        res.status,
        extractErrorMessage(body),
        extractErrorMeta(body),
      );
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") ?? "";
    // RFC 6266: filename* (UTF-8) takes precedence; fall back to plain filename.
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const ascii = /filename="?([^";]+)"?/i.exec(cd);
    const filename = utf8
      ? decodeURIComponent(utf8[1])
      : ascii
        ? ascii[1]
        : `resume.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // ─── Publish (read-only short link) ─────────────────────────────────────
  // POST → rotate token (old links 404 immediately).
  // DELETE → revoke (publish_token NULL, link 404s).
  publish: (resumeId: string) =>
    api<{ publishToken: string; publishedAt: string; publicUrl: string }>(
      `/api/resumes/${resumeId}/publish`,
      { method: "POST" },
    ),

  revokePublish: (resumeId: string) =>
    api<{ ok: boolean }>(`/api/resumes/${resumeId}/publish`, {
      method: "DELETE",
    }),
};

// Public résumé delivery (no auth — the token IS the capability).
export const publicResume = {
  fetch: (token: string) =>
    api<{
      basics: { name: string | null; label: string | null };
      parsed: object;
      markdown: string;
      version: number;
      publishedAt: string;
    }>(`/api/public/r/${encodeURIComponent(token)}`),
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

export interface UploadAttachmentResult {
  file: { id: string; filename: string; sizeBytes: number; kind: string };
  stored: boolean;
  kind: "pdf" | "docx" | "text" | "image";
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
      throw new ApiError(
        res.status,
        body.error?.message || body.error || "Upload failed",
        extractErrorMeta(body),
      );
    }
    return res.json();
  },

  // Generic chat attachment upload. Separate from upload() because the backend
  // route is different (/api/files/attachment): it accepts images in addition
  // to docs and does NOT run résumé extraction, so there's no markdown/text in
  // the response — just a stored reference for the chat composer to chip.
  uploadAttachment: async (file: File): Promise<UploadAttachmentResult> => {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/api/files/attachment`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(
        res.status,
        body.error?.message || body.error || "Upload failed",
        extractErrorMeta(body),
      );
    }
    return res.json();
  },

  // Presigned URL for the stored original. Surface area is small on purpose —
  // the URL is short-lived and the link is consumed by an iframe preview /
  // direct download in the Source drawer.
  download: (id: string) => api<{ url: string }>(`/api/files/${id}/download`),

  // INLINE-renderable preview URL for the Resume Studio Original Pane. PDFs
  // return an inline URL directly; DOCX is converted to PDF (cached) when a
  // converter is available, else `available:false` so the caller degrades to
  // a download link.
  preview: (id: string) =>
    api<{ available: boolean; kind: string; url?: string }>(
      `/api/files/${id}/preview`,
    ),
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

// Ask Vantage rail — drives the dock's RECENT list (vantage-ui-mapping
// §1.2). One lifetime thread per user, so we never list *sessions* the
// way `chat` above does; we only list anchors (recent user prompts that
// the dock can scroll back to).
export const ask = {
  recent: (limit = 10) =>
    api<{ items: Array<{ id: string; preview: string; createdAt: string }> }>(
      `/api/ask/recent?limit=${encodeURIComponent(String(limit))}`,
    ),
  // Full thread history for hydrating the dock's step timeline. Without this
  // every dock mount looked like a fresh window because the AG-UI step graph
  // only ever reflected the current turn — even though the lifetime thread
  // already had every prior message persisted in PG. Backed by
  // api/src/routes/ask.ts GET /history; threadId omitted defaults to the
  // lifetime ask_vantage:{user_id} thread.
  history: (threadId?: string, limit = 50) => {
    const params = new URLSearchParams();
    if (threadId) params.set("threadId", threadId);
    params.set("limit", String(limit));
    return api<{
      threadId: string;
      items: Array<{
        id: string;
        role: "user" | "assistant" | "system" | "tool";
        content: string;
        metadata: Record<string, unknown>;
        createdAt: string;
      }>;
    }>(`/api/ask/history?${params.toString()}`);
  },
  // Multi-session CRUD (migration 019). The dock's SessionSwitcher
  // (web/src/components/ask-vantage/session-switcher.tsx) drives every call.
  // The "+ New session" affordance hits create(), which the gateway answers
  // with a fresh ask_vantage:{userId}:{uuid} thread.
  sessions: {
    list: () =>
      api<{ items: AskSession[] }>(`/api/ask/sessions`),
    create: (label?: string) =>
      api<{ session: AskSession }>(`/api/ask/sessions`, {
        method: "POST",
        body: JSON.stringify(label ? { label } : {}),
      }),
    rename: (id: string, label: string) =>
      api<{ session: AskSession }>(`/api/ask/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ label }),
      }),
    remove: (id: string) =>
      api<{ deleted: string }>(`/api/ask/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },
};

export interface AskSession {
  id: string;
  threadId: string;
  label: string;
  preview: string | null;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

// Slash-command catalog (api/src/routes/slash.ts). Read once per palette
// open; the server-side cache absorbs the cost of repeated opens.
export interface SlashEntry {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: "skills" | "prompts" | "memory" | "agents";
}

export interface SlashCatalog {
  skills: SlashEntry[];
  prompts: SlashEntry[];
  memory: SlashEntry[];
  agents: SlashEntry[];
  generatedAt: string;
}

export const slash = {
  catalog: () => api<SlashCatalog>("/api/slash/catalog"),
};

// Today action queue (P3.1). Mixes prep / interview / learn signals
// into a single priority-sorted list — see api/src/routes/today.ts.
export type TodayActionKind = "prepare" | "follow_up" | "interview" | "learn";
export interface TodayAction {
  id: string;
  kind: TodayActionKind;
  title: string;
  sub: string;
  due_at?: string;
  priority: number;
  route: string;
  ask_prompt?: string;
}
export const today = {
  queue: () =>
    api<{ actions: TodayAction[]; generated_at: string }>("/api/today/queue"),
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
