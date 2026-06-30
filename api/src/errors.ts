import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Typed error hierarchy + unified envelope v2 (see docs/architecture/
// error-handling.md). Throw an AppError (or its subclasses) from any
// handler; the onError mapper turns it into:
//
//   {
//     "error": {
//       "code":       "AUTH_INVALID_CREDENTIALS",
//       "message":    "Invalid email or password",
//       "messageKey": "errors.auth.invalidCredentials",
//       "traceId":    "01HXY…",
//       "traceCode":  "R-3F8K",
//       "requestId":  "…",
//       "timestamp":  "2026-06-28T01:32:14.001Z",
//       "details":    { … },
//       "action":     { kind: "reauth", redirect: "/auth" }
//     }
//   }
//
// Unknown errors collapse to a 500 INTERNAL with no leak of internals.
// PG/Redis errors are translated by translateInfraError() before reaching
// that fallback — so a dead pool surfaces as DB_UNAVAILABLE (503), not
// "Internal server error" (500), and triggers the X-Relay-Health=degraded
// header so the web layer can render a global banner.

// ──────────────────────────────────────────────────────────────────────
// ErrorCode dictionary
//
// This is a STABLE TAXONOMY, not a free-form enum. New codes require a
// docs review (error-handling.md §3) and i18n entry in
// web/messages/{en,zh}/errors.json. Don't sneak codes in.
// ──────────────────────────────────────────────────────────────────────
export type ErrorCode =
  // input
  | "VALIDATION_FAILED"
  | "INPUT_FORMAT_UNSUPPORTED"
  // auth
  | "AUTH_REQUIRED"
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_SESSION_EXPIRED"
  | "AUTH_FORBIDDEN"
  | "AUTH_EMAIL_NOT_VERIFIED"
  // resource
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_CONFLICT"
  | "RESOURCE_GONE"
  // throttling
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  // upstream / infra
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "DB_UNAVAILABLE"
  | "CACHE_UNAVAILABLE"
  | "LLM_UNAVAILABLE"
  | "LLM_BUDGET_EXHAUSTED"
  | "LLM_CONTENT_REFUSED"
  | "LLM_FABRICATION_BLOCKED"
  // agent
  | "AGENT_TIMEOUT"
  | "AGENT_INTERRUPT_PENDING"
  | "AGENT_TASK_FAILED"
  // client / network
  | "NETWORK_OFFLINE"
  | "NETWORK_BLOCKED"
  | "CLIENT_VERSION_STALE"
  // generic
  | "INTERNAL"
  // ── Legacy aliases (kept so existing throw sites compile while the
  //    routes get migrated in W1.5; new code should use the names
  //    above). Removed at the end of W5. ─────────────────────────────
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "UPSTREAM";

// ──────────────────────────────────────────────────────────────────────
// ErrorAction — recommended next step the UI should offer.
// One of: retry now, force re-auth, contact support, wait for a
// maintenance window, fix specific form fields, or do nothing.
// ──────────────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────
// AppError — base class for every "expected" error inside the API.
// `messageKey` lets the web layer render a localized title/body without
// the server needing to know the user's locale. `action` is parsed by
// web/src/lib/errors/resolve.ts to build the CTA buttons.
// ──────────────────────────────────────────────────────────────────────
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: ContentfulStatusCode;
  readonly messageKey?: string;
  readonly action?: ErrorAction;
  readonly details?: unknown;
  /**
   * Optional engineering hint surfaced into Sentry/Langfuse breadcrumbs but
   * NEVER rendered to the user (see error-handling.md §2.3, P5 risk).
   */
  readonly causeHint?: {
    code?: ErrorCode;
    layer?: "web" | "api" | "agents" | "pg" | "redis" | "llm";
    message?: string;
  };

  constructor(
    message: string,
    detailsOrOpts?:
      | unknown
      | {
          details?: unknown;
          messageKey?: string;
          action?: ErrorAction;
          causeHint?: AppError["causeHint"];
        },
  ) {
    super(message);
    this.name = new.target.name;
    // Two-arg compatibility: pre-v2 sites pass `details` as the second
    // positional arg. Detect a "v2 opts" object by structural sniff
    // (non-null object with at least one of the v2 keys) — anything else
    // is treated as a legacy details payload. This keeps every existing
    // `throw new ValidationError("msg", { field })` site compiling
    // while v2 sites use `throw Errors.validation("msg", details, fields)`.
    const isV2Opts =
      detailsOrOpts !== null &&
      typeof detailsOrOpts === "object" &&
      ("details" in detailsOrOpts ||
        "messageKey" in detailsOrOpts ||
        "action" in detailsOrOpts ||
        "causeHint" in detailsOrOpts);
    if (isV2Opts) {
      const opts = detailsOrOpts as {
        details?: unknown;
        messageKey?: string;
        action?: ErrorAction;
        causeHint?: AppError["causeHint"];
      };
      this.details = opts.details;
      this.messageKey = opts.messageKey;
      this.action = opts.action;
      this.causeHint = opts.causeHint;
    } else {
      this.details = detailsOrOpts;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Subclasses
//
// We keep the legacy class names (ValidationError, NotFoundError, …) so
// every existing `throw new ValidationError(...)` site continues to
// compile while routes are migrated to `throw Errors.X(...)`. Each
// legacy class now carries the new envelope fields too.
//
// New code SHOULD use the `Errors` factory (below) — it's the single
// place that pairs each code with its default messageKey + action,
// which is what makes the front-end render consistent CTAs.
// ──────────────────────────────────────────────────────────────────────
export class ValidationError extends AppError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly status = 400 as const;
}

export class UnauthorizedError extends AppError {
  readonly code = "AUTH_REQUIRED" as const;
  readonly status = 401 as const;
}

export class AuthInvalidCredentialsError extends AppError {
  readonly code = "AUTH_INVALID_CREDENTIALS" as const;
  readonly status = 401 as const;
}

export class SessionExpiredError extends AppError {
  readonly code = "AUTH_SESSION_EXPIRED" as const;
  readonly status = 401 as const;
}

export class ForbiddenError extends AppError {
  readonly code = "AUTH_FORBIDDEN" as const;
  readonly status = 403 as const;
}

export class NotFoundError extends AppError {
  readonly code = "RESOURCE_NOT_FOUND" as const;
  readonly status = 404 as const;
}

export class ConflictError extends AppError {
  readonly code = "RESOURCE_CONFLICT" as const;
  readonly status = 409 as const;
}

export class GoneError extends AppError {
  readonly code = "RESOURCE_GONE" as const;
  readonly status = 410 as const;
}

export class RateLimitedError extends AppError {
  readonly code = "RATE_LIMITED" as const;
  readonly status = 429 as const;
}

export class QuotaExceededError extends AppError {
  readonly code = "QUOTA_EXCEEDED" as const;
  readonly status = 429 as const;
}

export class UpstreamError extends AppError {
  readonly code = "UPSTREAM_UNAVAILABLE" as const;
  readonly status = 502 as const;
}

export class UpstreamTimeoutError extends AppError {
  readonly code = "UPSTREAM_TIMEOUT" as const;
  readonly status = 504 as const;
}

export class DbUnavailableError extends AppError {
  readonly code = "DB_UNAVAILABLE" as const;
  readonly status = 503 as const;
}

export class CacheUnavailableError extends AppError {
  readonly code = "CACHE_UNAVAILABLE" as const;
  readonly status = 503 as const;
}

export class LlmUnavailableError extends AppError {
  readonly code = "LLM_UNAVAILABLE" as const;
  readonly status = 503 as const;
}

export class InputFormatUnsupportedError extends AppError {
  readonly code = "INPUT_FORMAT_UNSUPPORTED" as const;
  readonly status = 400 as const;
}

/**
 * 413 Payload Too Large. Same code as a generic validation failure
 * (the body shape is wrong: it exceeded the byte budget) but a
 * distinct subclass so the gateway emits the right HTTP status.
 */
export class PayloadTooLargeError extends AppError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly status = 413 as const;
}

// ──────────────────────────────────────────────────────────────────────
// Errors — factory namespace.
//
// Each helper is the SINGLE place where a code is paired with its
// default messageKey and recommended action. Throw sites read like
// English instead of constructor-ese:
//
//   throw Errors.invalidCreds()                 // 401 + no CTA
//   throw Errors.sessionExpired()               // 401 + reauth + redirect
//   throw Errors.dbUnavailable(err)             // 503 + retry CTA
//   throw Errors.rateLimited({ retryAfterSeconds: 7 })
//
// New codes get a new factory entry. Don't sprinkle messageKeys/actions
// across routes — that defeats the whole point of centralized copy.
// ──────────────────────────────────────────────────────────────────────
export const Errors = {
  // 400 input
  validation(
    msg = "Invalid input",
    details?: unknown,
    fields?: { name: string; msg: string }[],
  ): ValidationError {
    return new ValidationError(msg, {
      details,
      messageKey: "errors.validation.failed",
      action: fields ? { kind: "fix-input", fields } : { kind: "none" },
    });
  },

  inputFormatUnsupported(
    msg = "Unsupported file format",
    details?: unknown,
  ): InputFormatUnsupportedError {
    return new InputFormatUnsupportedError(msg, {
      details,
      messageKey: "errors.input.formatUnsupported",
      action: { kind: "none" },
    });
  },

  payloadTooLarge(msg: string, details?: unknown): PayloadTooLargeError {
    return new PayloadTooLargeError(msg, {
      details,
      messageKey: "errors.input.payloadTooLarge",
      action: { kind: "none" },
    });
  },

  // 401/403 auth
  authRequired(msg = "Authentication required"): UnauthorizedError {
    return new UnauthorizedError(msg, {
      messageKey: "errors.auth.required",
      action: { kind: "reauth", redirect: "/auth" },
    });
  },

  invalidCreds(): AuthInvalidCredentialsError {
    return new AuthInvalidCredentialsError("Invalid email or password", {
      messageKey: "errors.auth.invalidCredentials",
      action: { kind: "none" },
    });
  },

  sessionExpired(): SessionExpiredError {
    return new SessionExpiredError("Session expired", {
      messageKey: "errors.auth.sessionExpired",
      action: { kind: "reauth", redirect: "/auth?reason=session_expired" },
    });
  },

  forbidden(msg = "Forbidden"): ForbiddenError {
    return new ForbiddenError(msg, {
      messageKey: "errors.auth.forbidden",
      action: { kind: "none" },
    });
  },

  emailNotVerified(): AppError {
    return new (class extends AppError {
      readonly code = "AUTH_EMAIL_NOT_VERIFIED" as const;
      readonly status = 401 as const;
    })("Email not verified", {
      messageKey: "errors.auth.emailNotVerified",
      action: { kind: "contact", channel: "in-app" },
    });
  },

  // 404/409/410 resource
  notFound(msg = "Not found"): NotFoundError {
    return new NotFoundError(msg, {
      messageKey: "errors.resource.notFound",
      action: { kind: "none" },
    });
  },

  conflict(msg: string, details?: unknown): ConflictError {
    return new ConflictError(msg, {
      details,
      messageKey: "errors.resource.conflict",
      action: { kind: "none" },
    });
  },

  gone(msg = "Gone"): GoneError {
    return new GoneError(msg, {
      messageKey: "errors.resource.gone",
      action: { kind: "none" },
    });
  },

  // 429
  rateLimited(opts: {
    scope?: string;
    limit?: number;
    windowSeconds?: number;
    retryAfterSeconds: number;
  }): RateLimitedError {
    return new RateLimitedError(
      `Rate limit exceeded${opts.scope ? ` for ${opts.scope}` : ""}. Try again in ${opts.retryAfterSeconds}s.`,
      {
        details: opts,
        messageKey: "errors.throttling.rateLimited",
        action: { kind: "retry", after: opts.retryAfterSeconds },
      },
    );
  },

  quotaExceeded(details?: unknown): QuotaExceededError {
    return new QuotaExceededError("Quota exceeded", {
      details,
      messageKey: "errors.throttling.quotaExceeded",
      action: { kind: "contact", channel: "in-app" },
    });
  },

  // 5xx upstream / infra
  upstreamUnavailable(cause?: Error): UpstreamError {
    return new UpstreamError("Upstream service unavailable", {
      messageKey: "errors.upstream.unavailable",
      action: { kind: "retry", after: 5 },
      causeHint: cause
        ? { layer: "agents", message: cause.message.slice(0, 200) }
        : undefined,
    });
  },

  upstreamTimeout(cause?: Error): UpstreamTimeoutError {
    return new UpstreamTimeoutError("Upstream request timed out", {
      messageKey: "errors.upstream.timeout",
      action: { kind: "retry", after: 5 },
      causeHint: cause
        ? { layer: "agents", message: cause.message.slice(0, 200) }
        : undefined,
    });
  },

  dbUnavailable(cause?: Error): DbUnavailableError {
    return new DbUnavailableError("Database temporarily unavailable", {
      messageKey: "errors.system.dbUnavailable",
      action: { kind: "retry", after: 5 },
      causeHint: cause
        ? { layer: "pg", message: cause.message.slice(0, 200) }
        : undefined,
    });
  },

  cacheUnavailable(cause?: Error): CacheUnavailableError {
    return new CacheUnavailableError("Cache temporarily unavailable", {
      messageKey: "errors.system.cacheUnavailable",
      action: { kind: "retry", after: 5 },
      causeHint: cause
        ? { layer: "redis", message: cause.message.slice(0, 200) }
        : undefined,
    });
  },

  llmUnavailable(cause?: Error): LlmUnavailableError {
    return new LlmUnavailableError("Reasoning engine unavailable", {
      messageKey: "errors.llm.unavailable",
      action: { kind: "retry", after: 10 },
      causeHint: cause
        ? { layer: "llm", message: cause.message.slice(0, 200) }
        : undefined,
    });
  },

  // Generic
  internal(): AppError {
    return new (class extends AppError {
      readonly code = "INTERNAL" as const;
      readonly status = 500 as const;
    })("Internal server error", {
      messageKey: "errors.system.internal",
      action: { kind: "retry", after: 5 },
    });
  },
};

// ──────────────────────────────────────────────────────────────────────
// translateInfraError — turn raw infrastructure exceptions into typed
// AppErrors BEFORE the generic 500 fallback fires.
//
// Without this, a dead PG pool surfaces to the user as the literal
// string "Internal server error" (which is what happened on 2026-06-28
// — see error-handling.md §9 G6). With this, the same situation
// surfaces as DB_UNAVAILABLE with a friendly title/body, a Retry CTA,
// and X-Relay-Health=degraded driving the global banner.
//
// Returns null when no rule matches → caller falls through to INTERNAL.
// ──────────────────────────────────────────────────────────────────────
export function translateInfraError(err: unknown): AppError | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message ?? "";
  const stack = err.stack ?? "";
  // pg's error codes (https://www.postgresql.org/docs/current/errcodes-appendix.html)
  // — 'code' is added by node-postgres for SqlError instances.
  const pgCode = (err as Error & { code?: string }).code ?? "";
  // PG pool died / connection broke
  if (/Cannot use a pool after calling end on the pool/i.test(msg)) {
    return Errors.dbUnavailable(err);
  }
  if (/Connection terminated unexpectedly/i.test(msg)) {
    return Errors.dbUnavailable(err);
  }
  if (/terminating connection due to administrator command/i.test(msg)) {
    return Errors.dbUnavailable(err);
  }
  if (
    /Client has encountered a connection error and is not queryable/i.test(msg)
  ) {
    return Errors.dbUnavailable(err);
  }
  // Stack-trace heuristic: when pg-pool's idle-error path re-throws an
  // empty Error (no message preserved), the only signal we have is the
  // pg-pool frame in the stack. Catch it so the user gets a real
  // DB_UNAVAILABLE card instead of the catch-all INTERNAL.
  if (/pg-pool/i.test(stack)) {
    return Errors.dbUnavailable(err);
  }
  // node-postgres SQLSTATE codes that mean "the database is unavailable":
  //   57P01 = admin_shutdown
  //   57P02 = crash_shutdown
  //   57P03 = cannot_connect_now
  //   08*** = connection exceptions
  if (
    pgCode === "57P01" ||
    pgCode === "57P02" ||
    pgCode === "57P03" ||
    pgCode.startsWith("08")
  ) {
    return Errors.dbUnavailable(err);
  }
  if (/ECONNREFUSED/i.test(msg) && /(5432|5433|postgres)/i.test(msg)) {
    return Errors.dbUnavailable(err);
  }
  // Redis went away. Note ioredis surfaces "Connection is closed." for
  // most lifecycle failures including reconnect storms — we treat any
  // of them as CACHE_UNAVAILABLE because the gateway's caches are
  // best-effort everywhere.
  if (
    /Connection is closed/i.test(msg) &&
    /redis|ioredis/i.test(err.name + msg)
  ) {
    return Errors.cacheUnavailable(err);
  }
  if (err.name === "TimeoutError" || /\bETIMEDOUT\b/i.test(msg)) {
    return Errors.upstreamTimeout(err);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// traceCodeFromTraceId — derive the user-facing short code "R-XXXX"
// from a UUID. The code is a deterministic function of the traceId, so
// support can reverse the lookup deterministically too.
//
// We crockford-base32 the first 40 bits (10 hex chars) of the UUID's hex
// form (ignoring dashes), shifted into a 4-char code. Collisions are
// fine for an OPS lookup hint — we never trust traceCode as a primary
// key, only traceId.
// ──────────────────────────────────────────────────────────────────────
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function traceCodeFromTraceId(traceId: string): string {
  const hex = traceId.replace(/-/g, "").slice(0, 10);
  if (hex.length < 10) return "R-0000";
  // 40 bits → take 4 base32 chars (20 bits) for a short, readable code.
  // We use parseInt twice to avoid 53-bit JS number limits on the hex.
  const high = parseInt(hex.slice(0, 5), 16);
  const low = parseInt(hex.slice(5, 10), 16);
  const folded = high ^ low; // ~20-bit space
  let out = "";
  let n = folded;
  for (let i = 0; i < 4; i++) {
    out = CROCKFORD[n & 0x1f] + out;
    n = n >>> 5;
  }
  return `R-${out}`;
}

// ──────────────────────────────────────────────────────────────────────
// ErrorEnvelope v2
//
// One shape across the whole stack. The Python agents emit the same
// fields (see agents/api/server.py error_envelope()). The web layer's
// ApiError parses this shape directly. Any change to this type is a
// cross-layer migration — bump a version number.
// ──────────────────────────────────────────────────────────────────────
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    messageKey?: string;
    traceId: string;
    traceCode: string;
    requestId?: string;
    timestamp: string;
    details?: unknown;
    action?: ErrorAction;
    cause?: AppError["causeHint"];
  };
}

export interface ToErrorResponseOptions {
  traceId?: string;
  requestId?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Code-keyed envelope defaults
//
// error-handling.md §4 (P4 "able-to-recover > able-to-explain") requires
// every emitted envelope to carry a `messageKey` and an `action` — the
// web error-router (`web/src/lib/errors/resolve.ts`) reads `action.kind`
// to render the right CTA. Throw sites that construct an AppError
// subclass directly (`throw new UpstreamError("…", err.message)`) skip
// the `Errors.*` factories and therefore never set those fields, which
// silently degrades the user-facing toast back to "Something went
// wrong" copy with no Retry button.
//
// To make the contract hold without forcing every throw site to migrate
// to the factory, `toErrorResponse` consults this table and fills in
// sensible defaults whenever the AppError omits them. The factory still
// wins (it can override per-call), and throw sites that genuinely want a
// silent action can pass `{ action: { kind: "none" } }` explicitly.
// ──────────────────────────────────────────────────────────────────────
const DEFAULT_ENVELOPE_BY_CODE: Partial<
  Record<ErrorCode, { messageKey?: string; action?: ErrorAction }>
> = {
  // input
  VALIDATION_FAILED: {
    messageKey: "errors.validation.failed",
    action: { kind: "none" },
  },
  INPUT_FORMAT_UNSUPPORTED: {
    messageKey: "errors.input.formatUnsupported",
    action: { kind: "none" },
  },
  // auth
  AUTH_REQUIRED: {
    messageKey: "errors.auth.required",
    action: { kind: "reauth", redirect: "/auth" },
  },
  AUTH_INVALID_CREDENTIALS: {
    messageKey: "errors.auth.invalidCredentials",
    action: { kind: "none" },
  },
  AUTH_SESSION_EXPIRED: {
    messageKey: "errors.auth.sessionExpired",
    action: { kind: "reauth", redirect: "/auth" },
  },
  AUTH_FORBIDDEN: {
    messageKey: "errors.auth.forbidden",
    action: { kind: "none" },
  },
  AUTH_EMAIL_NOT_VERIFIED: {
    messageKey: "errors.auth.emailNotVerified",
    action: { kind: "contact", channel: "email" },
  },
  // resource
  RESOURCE_NOT_FOUND: {
    messageKey: "errors.resource.notFound",
    action: { kind: "none" },
  },
  RESOURCE_CONFLICT: {
    messageKey: "errors.resource.conflict",
    action: { kind: "retry", after: 1 },
  },
  RESOURCE_GONE: {
    messageKey: "errors.resource.gone",
    action: { kind: "none" },
  },
  // throttling
  RATE_LIMITED: {
    messageKey: "errors.rate.limited",
    action: { kind: "retry", after: 10 },
  },
  QUOTA_EXCEEDED: {
    messageKey: "errors.throttling.quotaExceeded",
    action: { kind: "contact", channel: "in-app" },
  },
  // upstream / infra
  UPSTREAM_UNAVAILABLE: {
    messageKey: "errors.upstream.unavailable",
    action: { kind: "retry", after: 5 },
  },
  UPSTREAM_TIMEOUT: {
    messageKey: "errors.upstream.timeout",
    action: { kind: "retry", after: 5 },
  },
  DB_UNAVAILABLE: {
    messageKey: "errors.system.dbUnavailable",
    action: { kind: "retry", after: 5 },
  },
  CACHE_UNAVAILABLE: {
    messageKey: "errors.system.cacheUnavailable",
    action: { kind: "retry", after: 5 },
  },
  LLM_UNAVAILABLE: {
    messageKey: "errors.llm.unavailable",
    action: { kind: "retry", after: 10 },
  },
  LLM_BUDGET_EXHAUSTED: {
    messageKey: "errors.llm.budgetExhausted",
    action: { kind: "contact", channel: "in-app" },
  },
  LLM_CONTENT_REFUSED: {
    messageKey: "errors.llm.contentRefused",
    action: { kind: "none" },
  },
  LLM_FABRICATION_BLOCKED: {
    messageKey: "errors.llm.fabricationBlocked",
    action: { kind: "none" },
  },
  // agent
  AGENT_TIMEOUT: {
    messageKey: "errors.agent.timeout",
    action: { kind: "retry", after: 5 },
  },
  AGENT_INTERRUPT_PENDING: {
    messageKey: "errors.agent.interruptPending",
    action: { kind: "none" },
  },
  AGENT_TASK_FAILED: {
    messageKey: "errors.agent.taskFailed",
    action: { kind: "retry", after: 5 },
  },
  // client / network — these are usually emitted client-side but defaults
  // help when a route surfaces them too.
  NETWORK_BLOCKED: {
    messageKey: "errors.network.blocked",
    action: { kind: "none" },
  },
  CLIENT_VERSION_STALE: {
    messageKey: "errors.client.versionStale",
    action: { kind: "none" },
  },
  // generic
  INTERNAL: {
    messageKey: "errors.system.internal",
    action: { kind: "retry", after: 5 },
  },
  // legacy aliases — fall through to the equivalent modern code's default
  // (kept inline so the table stays the single source of truth).
  VALIDATION: {
    messageKey: "errors.validation.failed",
    action: { kind: "none" },
  },
  NOT_FOUND: {
    messageKey: "errors.resource.notFound",
    action: { kind: "none" },
  },
  CONFLICT: {
    messageKey: "errors.resource.conflict",
    action: { kind: "retry", after: 1 },
  },
  UNAUTHORIZED: {
    messageKey: "errors.auth.required",
    action: { kind: "reauth", redirect: "/auth" },
  },
  FORBIDDEN: {
    messageKey: "errors.auth.forbidden",
    action: { kind: "none" },
  },
  UPSTREAM: {
    messageKey: "errors.upstream.unavailable",
    action: { kind: "retry", after: 5 },
  },
};

function defaultsForCode(code: ErrorCode): {
  messageKey?: string;
  action?: ErrorAction;
} {
  return DEFAULT_ENVELOPE_BY_CODE[code] ?? {};
}

/**
 * Map any thrown value to a typed error envelope + HTTP status.
 *
 * Resolution order:
 *   1. AppError instance → use its fields directly.
 *   2. Otherwise translateInfraError() — turns pool/Redis/timeout
 *      exceptions into the right AppError.
 *   3. Otherwise INTERNAL 500 with no leak.
 */
export function toErrorResponse(
  err: unknown,
  opts: ToErrorResponseOptions = {},
): {
  body: ErrorEnvelope;
  status: ContentfulStatusCode;
  appError: AppError;
} {
  const appError =
    err instanceof AppError
      ? err
      : (translateInfraError(err) ?? Errors.internal());

  const traceId = opts.traceId ?? crypto.randomUUID();
  const traceCode = traceCodeFromTraceId(traceId);

  // Fill missing messageKey/action with code-keyed defaults so every emitted
  // envelope satisfies error-handling.md §4 (P4). Throw sites that genuinely
  // want neither can override via `{ action: { kind: "none" } }`.
  const defaults = defaultsForCode(appError.code);
  const messageKey = appError.messageKey ?? defaults.messageKey;
  const action = appError.action ?? defaults.action;

  return {
    status: appError.status,
    appError,
    body: {
      error: {
        code: appError.code,
        message: appError.message,
        ...(messageKey ? { messageKey } : {}),
        traceId,
        traceCode,
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        timestamp: new Date().toISOString(),
        ...(appError.details !== undefined
          ? { details: appError.details }
          : {}),
        ...(action ? { action } : {}),
        ...(appError.causeHint ? { cause: appError.causeHint } : {}),
      },
    },
  };
}

/**
 * Codes that mean "system degraded" — used to set the X-Relay-Health
 * response header so the web layer can render a single global banner
 * instead of a toast on every page.
 */
const DEGRADED_CODES = new Set<ErrorCode>([
  "DB_UNAVAILABLE",
  "CACHE_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "LLM_UNAVAILABLE",
]);

/** Hono onError handler: logs unexpected errors, returns the envelope. */
export function errorHandler(err: Error, c: Context): Response {
  const traceId =
    (c.get("traceId" as never) as string | undefined) ?? crypto.randomUUID();
  const requestId = c.get("requestId" as never) as string | undefined;

  const { body, status, appError } = toErrorResponse(err, {
    traceId,
    requestId,
  });

  // 5xx is loud (we want to fix root causes). 4xx is control flow.
  // Note: translated infra errors emit a 5xx code, so the pool-dead
  // path gets logged the same way an unhandled exception would.
  if (status >= 500) {
    console.error(
      `[API Error] ${c.req.method} ${c.req.url} → ${appError.code} trace=${traceId} cause=${err.stack ?? err.message}`,
    );
  }

  // Trace + request correlation headers, always present so the
  // browser/devtools can pick them off without parsing JSON.
  c.header("X-Trace-Id", traceId);
  if (requestId) c.header("X-Request-Id", requestId);

  // Degraded-mode signal: drives the global HealthBanner on the web
  // side (W5.1). When everything's fine the header is absent.
  if (DEGRADED_CODES.has(appError.code)) {
    c.header("X-Relay-Health", "degraded");
  }

  return c.json(body, status);
}
