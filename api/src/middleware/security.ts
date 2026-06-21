import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { config } from "../config";

// Security hardening middleware (API-026): defense-in-depth response headers,
// a request body-size cap, and a CORS origin resolver that also admits the
// browser extension. Composed in index.ts ahead of the route mounts.

/** Max JSON/form body we accept, in bytes (default 1 MiB; resumes are small). */
export const MAX_BODY_BYTES = 1024 * 1024;

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

/** Reject oversized bodies with a 413 (Hono's bodyLimit handles the response). */
export const bodySizeLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: {
          code: "VALIDATION",
          message: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        },
      },
      413,
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
