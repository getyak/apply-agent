// Error router — Layer 2 of the web error stack (see
// docs/architecture/error-handling.md §4.3.2). Takes an ApiError (or
// anything that might be an error) plus the page context, and returns
// a ResolvedError that the presentation components render verbatim.
//
// The decision matrix lives here, not in the components, so:
//   - every UI surface gets the same CTA / severity / placement
//   - product can override per-page in one place (ctx.page)
//   - we test the matrix once instead of in every component

import { ApiError } from "../api";
import type { ErrorAction } from "../api";

export type SurfaceKind = "toast" | "inline" | "banner" | "full-page" | "silent";

export type Severity = "info" | "warning" | "error" | "critical";

export interface Cta {
  /** stable id so click telemetry can branch */
  id: "retry" | "reauth" | "report" | "open-doc" | "dismiss" | "contact";
  /** i18n key for the visible label */
  labelKey: string;
  /** opaque payload the consumer uses to act (URL, ms, fields…) */
  data?: Record<string, unknown>;
}

export interface ResolvedError {
  surface: SurfaceKind;
  severity: Severity;
  /**
   * i18n key for the headline. Renderers do
   *   t(`${titleKey}`)
   * — falling back to a humanized version of the code if the
   * key isn't in the bundle yet.
   */
  titleKey: string;
  /** i18n key for the body copy. Same fallback as titleKey. */
  bodyKey: string;
  /** Variables for the body string (e.g. retryAfterSeconds → "{seconds}"). */
  bodyVars?: Record<string, string | number>;
  ctas: Cta[];
  /**
   * Short user-facing reference. Defined whenever we have a traceId.
   * Renderers show this verbatim — DO NOT translate.
   */
  traceCode?: string;
  /**
   * Everything the support copy clipboard write needs in one object,
   * shape stable so we can ship a single template.
   */
  copyable: {
    traceId?: string;
    traceCode?: string;
    requestId?: string;
    timestamp?: string;
    code?: string;
  };
  /** The original error, kept around for the dev-mode "show raw" toggle. */
  raw: ApiError | Error | unknown;
}

export interface ErrorContext {
  /**
   * Which surface produced the error. The matrix uses this to choose
   * inline vs toast (e.g. validation in a form goes inline; the same
   * validation outside a form falls back to a toast).
   */
  page?:
    | "auth"
    | "dock"
    | "studio.resume"
    | "studio.mock"
    | "applications"
    | "today"
    | "trends"
    | "settings"
    | "generic";
  /**
   * Hint to overrides: if the surface that called us is already a form,
   * VALIDATION_FAILED renders as inline (under the field) instead of as
   * a toast. The auth page sets this to true.
   */
  inForm?: boolean;
}

/**
 * The decision matrix — see docs §4.3.3.
 *
 * Keep this dumb: a code (+ small context flags) maps to one row.
 * Don't import components here — that creates cycles. The renderer
 * picks up the row and decides how to draw it.
 */
function rowFor(
  code: string | undefined,
  ctx: ErrorContext,
): {
  surface: SurfaceKind;
  severity: Severity;
  ctaIds: Cta["id"][];
} {
  const inForm = ctx.inForm === true || ctx.page === "auth";
  switch (code) {
    case "VALIDATION_FAILED":
    case "INPUT_FORMAT_UNSUPPORTED":
      return { surface: inForm ? "inline" : "toast", severity: "warning", ctaIds: [] };

    case "AUTH_INVALID_CREDENTIALS":
    case "AUTH_EMAIL_NOT_VERIFIED":
    case "AUTH_REQUIRED":
      return {
        surface: ctx.page === "auth" ? "inline" : "toast",
        severity: "warning",
        ctaIds: code === "AUTH_REQUIRED" ? ["reauth"] : ["dismiss"],
      };

    case "AUTH_SESSION_EXPIRED":
      return { surface: "banner", severity: "warning", ctaIds: ["reauth"] };

    case "AUTH_FORBIDDEN":
      return { surface: "toast", severity: "warning", ctaIds: ["dismiss"] };

    case "RESOURCE_NOT_FOUND":
    case "RESOURCE_CONFLICT":
    case "RESOURCE_GONE":
      return { surface: "toast", severity: "warning", ctaIds: ["dismiss"] };

    case "RATE_LIMITED":
    case "QUOTA_EXCEEDED":
      return {
        surface: "toast",
        severity: "warning",
        ctaIds: code === "RATE_LIMITED" ? ["dismiss"] : ["contact"],
      };

    // Infra / upstream — degraded codes show in the global banner.
    // We still emit a toast so the failing in-flight action has
    // immediate feedback near the click, not just up top.
    case "DB_UNAVAILABLE":
    case "CACHE_UNAVAILABLE":
    case "UPSTREAM_UNAVAILABLE":
    case "UPSTREAM_TIMEOUT":
      return { surface: "toast", severity: "error", ctaIds: ["retry", "report"] };

    case "LLM_UNAVAILABLE":
      // Dock / mock are inline contexts — fold into the chat instead
      // of a stray toast.
      return {
        surface:
          ctx.page === "dock" || ctx.page === "studio.mock" ? "inline" : "toast",
        severity: "error",
        ctaIds: ["retry", "report"],
      };

    case "LLM_BUDGET_EXHAUSTED":
      return { surface: "toast", severity: "warning", ctaIds: ["contact"] };

    case "LLM_CONTENT_REFUSED":
      return { surface: "inline", severity: "warning", ctaIds: ["dismiss"] };

    case "LLM_FABRICATION_BLOCKED":
      // Vantage red line (vantage-ui-mapping.md §2.3). We *want* the user
      // to read why — toast is too easy to dismiss.
      return { surface: "inline", severity: "warning", ctaIds: ["open-doc"] };

    case "AGENT_TIMEOUT":
    case "AGENT_TASK_FAILED":
      return { surface: "toast", severity: "error", ctaIds: ["retry", "report"] };

    case "AGENT_INTERRUPT_PENDING":
      // Not an error — HITL state. Caller should branch on this code
      // before calling resolveError. If they didn't, render as silent.
      return { surface: "silent", severity: "info", ctaIds: [] };

    case "NETWORK_OFFLINE":
      return { surface: "banner", severity: "warning", ctaIds: ["dismiss"] };

    case "NETWORK_BLOCKED":
      return { surface: "banner", severity: "warning", ctaIds: ["open-doc"] };

    case "CLIENT_VERSION_STALE":
      return { surface: "banner", severity: "info", ctaIds: ["retry"] };

    case "INTERNAL":
    default:
      return { surface: "toast", severity: "error", ctaIds: ["retry", "report"] };
  }
}

const CTA_LABEL_KEYS: Record<Cta["id"], string> = {
  retry: "errors._common.retry",
  reauth: "errors._common.signIn",
  report: "errors._common.reportProblem",
  "open-doc": "errors._common.learnMore",
  dismiss: "errors._common.dismiss",
  contact: "errors._common.contact",
};

/**
 * Map a code → its i18n namespace. We keep this as a function rather
 * than a static table so that unknown codes always resolve to a SHAPE
 * (a key path that exists in the bundle), even if the bundle is stale.
 */
function keysFor(code: string | undefined): { titleKey: string; bodyKey: string } {
  // Convention: errors.<domain>.<camelCode>
  if (!code) {
    return { titleKey: "errors._common.unknownTitle", bodyKey: "errors._common.unknownBody" };
  }
  const lower = code.toLowerCase();
  const parts = lower.split("_");
  if (parts.length < 2) {
    return {
      titleKey: `errors._common.unknownTitle`,
      bodyKey: `errors._common.unknownBody`,
    };
  }
  const domain = parts[0];
  const rest = parts.slice(1);
  const tail = rest
    .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join("");
  const mapped = remapDomain(domain);
  return {
    titleKey: `errors.${mapped}.${tail}.title`,
    bodyKey: `errors.${mapped}.${tail}.body`,
  };
}

/**
 * Some codes use a domain prefix that doesn't match the i18n namespace
 * (e.g. CACHE_UNAVAILABLE belongs under system.*, RATE_LIMITED under
 * throttling.*). This is the one place to map them.
 */
function remapDomain(domain: string): string {
  switch (domain) {
    case "db":
    case "cache":
    case "internal":
      return "system";
    case "rate":
    case "quota":
      return "throttling";
    case "upstream":
      return "upstream";
    case "agent":
      return "agent";
    case "client":
      return "client";
    default:
      return domain;
  }
}

/**
 * The body for some codes wants server-side values (retry seconds, etc).
 * Pull whatever we can from details / action.
 */
function bodyVarsFor(err: ApiError): Record<string, string | number> | undefined {
  const vars: Record<string, string | number> = {};
  if (err.action?.kind === "retry" && err.action.after) {
    vars.seconds = err.action.after;
  }
  const d = err.details;
  if (d && typeof d === "object" && d !== null) {
    const rec = d as Record<string, unknown>;
    if (typeof rec.retryAfterSeconds === "number") {
      vars.seconds = rec.retryAfterSeconds;
    }
    if (typeof rec.spentCents === "number") {
      vars.spentCents = rec.spentCents;
    }
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

/**
 * Build a CTA from a CTA id, threading the server's `action` data into
 * any clickable that needs it (retry's `after`, reauth's `redirect`).
 */
function ctaFor(id: Cta["id"], action: ErrorAction | undefined): Cta {
  const labelKey = CTA_LABEL_KEYS[id];
  if (!action) return { id, labelKey };
  if (id === "retry" && action.kind === "retry") {
    return { id, labelKey, data: { after: action.after } };
  }
  if (id === "reauth" && action.kind === "reauth") {
    return { id, labelKey, data: { redirect: action.redirect } };
  }
  return { id, labelKey };
}

/**
 * Main entry. Accepts anything because consumers catch `unknown`;
 * non-ApiError values are wrapped into a synthetic INTERNAL so the
 * renderer always has a typed object.
 */
export function resolveError(err: unknown, ctx: ErrorContext = {}): ResolvedError {
  const apiErr =
    err instanceof ApiError
      ? err
      : new ApiError(0, err instanceof Error ? err.message : "Unknown error", {
          code: "INTERNAL",
          messageKey: "errors.system.internal",
        });

  const row = rowFor(apiErr.code, ctx);
  const keys = apiErr.messageKey
    ? messageKeyToTitleBody(apiErr.messageKey)
    : keysFor(apiErr.code);

  // If the server gave us an explicit action of `none`, drop the default
  // CTAs — the matrix shouldn't override the server's intent. Otherwise
  // the matrix's ctaIds win; the server's `action` only seeds data.
  const ctaIds =
    apiErr.action?.kind === "none" ? row.ctaIds.filter((id) => id === "report") : row.ctaIds;
  const ctas = ctaIds.map((id) => ctaFor(id, apiErr.action));

  return {
    surface: row.surface,
    severity: row.severity,
    titleKey: keys.titleKey,
    bodyKey: keys.bodyKey,
    bodyVars: bodyVarsFor(apiErr),
    ctas,
    traceCode: apiErr.traceCode,
    copyable: {
      traceId: apiErr.traceId,
      traceCode: apiErr.traceCode,
      requestId: apiErr.requestId,
      timestamp: apiErr.timestamp,
      code: apiErr.code,
    },
    raw: err,
  };
}

/**
 * Server-supplied messageKey often looks like "errors.auth.invalidCredentials"
 * and points at an object `{ title, body }` in the bundle. Append the
 * leaves so the renderer's t() resolves directly.
 */
function messageKeyToTitleBody(messageKey: string): {
  titleKey: string;
  bodyKey: string;
} {
  return { titleKey: `${messageKey}.title`, bodyKey: `${messageKey}.body` };
}

/**
 * Convenience for the global health banner (W5.1) and any caller that
 * wants to know if a particular error signals system degradation.
 */
export function isDegraded(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.healthStatus === "degraded") return true;
  return (
    err.code === "DB_UNAVAILABLE" ||
    err.code === "CACHE_UNAVAILABLE" ||
    err.code === "UPSTREAM_UNAVAILABLE" ||
    err.code === "UPSTREAM_TIMEOUT" ||
    err.code === "LLM_UNAVAILABLE"
  );
}
