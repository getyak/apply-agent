import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Context } from "hono";
import { config } from "../config";
import { Errors, toErrorResponse } from "../errors";

/**
 * bodyLimit's onError must RETURN a Response (it can't throw and trust
 * an app-level onError to catch — it sits at a layer before Hono's
 * usual error handling). So we run the same toErrorResponse pipeline
 * inline to keep the envelope v2 contract intact even on these
 * pre-route 413s.
 */
function payloadTooLargeResponse(c: Context, msg: string): Response {
  const traceId = (c.get("traceId" as never) as string | undefined) ?? crypto.randomUUID();
  const requestId = c.get("requestId" as never) as string | undefined;
  const { body, status } = toErrorResponse(Errors.payloadTooLarge(msg), {
    traceId,
    requestId,
  });
  c.header("X-Trace-Id", traceId);
  if (requestId) c.header("X-Request-Id", requestId);
  return c.json(body, status);
}

// Security hardening middleware (API-026): defense-in-depth response headers,
// a request body-size cap, and a CORS origin resolver that also admits the
// browser extension. Composed in index.ts ahead of the route mounts.

/** Max JSON/form body we accept, in bytes (default 1 MiB; resumes are small). */
export const MAX_BODY_BYTES = 1024 * 1024;

// FILES_SIZE1 (round-18): the round-18 audit found that the global
// 1 MiB body cap fired before files.ts's 8 MiB cap, so a legitimate
// 50-page PDF (≈ 2.5 MiB — well under the round-17 MAX_PDF_PAGES = 50
// cap) was rejected at the gateway before extract.ts ever saw it. The
// round-17 page-count cap and the global body cap implied two
// inconsistent realities. Resolve the conflict by making the global
// cap authoritative for JSON / form payloads (1 MiB stays generous;
// the largest JSON we ship is a tailored résumé under 200 KB) and
// adding a separate larger ceiling for the file-upload route that
// matches the existing in-route MAX_BYTES = 8 MiB. The file route
// re-applies its own multipart size check, so this is a ceiling, not
// a target.
export const MAX_LARGE_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Standard security headers via Hono's built-in. Conservative defaults: no
 * referrer leakage, nosniff, framing denied, HSTS in production only (HSTS over
 * plain HTTP in dev would pin localhost to https and break the dev server).
 */
export const securityHeaders = secureHeaders({
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  strictTransportSecurity:
    config.NODE_ENV === "production"
      ? "max-age=31536000; includeSubDomains"
      : false,
  // CSP1 (round-14): the round-14 audit pointed out that the prior CSP
  // collapsed to `default-src 'none'` and silently inherited that for
  // every other directive. That's correct for a pure-JSON API in
  // isolation, but the moment a /healthz HTML page, an OAuth callback,
  // or an internal docs page lands on this host, the first deploy will
  // be unusable. Spell out an explicit, layered policy: no scripts at
  // all (this gateway never serves them), same-origin for connect /
  // style / img / font (data: image URIs allowed because the auth
  // page emits an SVG logo), no objects, no embeds, no inline
  // anything. `frameAncestors`, `baseUri`, and `formAction` close the
  // long-tail clickjack / `<base>`-hijack / form-action-leak surfaces
  // that round-7 SEC4 hinted at but didn't pin down. `report-to` is
  // intentionally omitted until round-15 designs the collector
  // endpoint (CSP5 in round-14 findings).
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'none'"],
    styleSrc: ["'self'"],
    connectSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
  },
});

/**
 * Reject oversized bodies with a 413. Routes through the standard
 * AppError → onError pipeline so the response carries the envelope v2
 * fields (traceCode, action, etc.) instead of a one-off hand-rolled
 * shape (see docs/architecture/error-handling.md §4.1.4).
 */
export const bodySizeLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    payloadTooLargeResponse(
      c,
      `Request body exceeds ${MAX_BODY_BYTES} bytes`,
    ),
});

/**
 * FILES_SIZE1 (round-18): same shape as `bodySizeLimit` but with the
 * larger ceiling — apply route-scoped on the file-upload paths in
 * `routes/files.ts` and `routes/resumes.ts` to let legitimate
 * multi-page résumés through while the global 1 MiB cap continues to
 * police every other path. files.ts still applies its own per-upload
 * check; this is the gateway-level ceiling that matches it.
 */
export const largeBodySizeLimit = bodyLimit({
  maxSize: MAX_LARGE_BODY_BYTES,
  onError: (c) =>
    payloadTooLargeResponse(
      c,
      `Upload body exceeds ${MAX_LARGE_BODY_BYTES} bytes`,
    ),
});

// Loopback host literals we admit in development — covers IPv4, the
// `localhost` alias, and IPv6. Port is free-form so a `prod build` running
// on 3010 or a Playwright smoke binding 3030 just works without touching
// CORS_ORIGINS. Production is unaffected.
const LOOPBACK_HOST_RE =
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

/**
 * CORS origin resolver. Returns the origin to echo back (enabling credentials)
 * or null to deny. Allows:
 *   - the configured web origins from CORS_ORIGINS,
 *   - any `chrome-extension://` origin (the client-side delivery extension
 *     calls the API from its own origin and must be permitted, but only the
 *     extension scheme — not arbitrary cross-site pages),
 *   - in non-production runs only, any loopback host (127.0.0.1 / localhost
 *     / [::1]) on any port. test-run-2026-06-18 § 5 hit this: a prod build
 *     run on 127.0.0.1:3010 was blocked by a default allowlist of
 *     localhost:3000, and the fix would otherwise need each dev to remember
 *     to bump CORS_ORIGINS by hand.
 */
export function resolveCorsOrigin(origin: string): string | null {
  if (!origin) return null;
  if (config.corsOrigins.includes(origin)) return origin;
  if (origin.startsWith("chrome-extension://")) return origin;
  if (config.NODE_ENV !== "production" && LOOPBACK_HOST_RE.test(origin)) {
    return origin;
  }
  return null;
}
