"use client";

// Global health banner — single top-pinned strip rendered when the API
// gateway has flagged the stack as degraded via the X-Relay-Health
// response header. Reads zustand health-store (lib/health-store.ts),
// updated by api-client on every response.
//
// Why this is its own component, not a one-off ErrorBanner: the matrix
// in error-router.ts (W2.3) explicitly routes DB_UNAVAILABLE /
// CACHE_UNAVAILABLE / UPSTREAM_TIMEOUT through the global banner so
// you don't get N toasts when 30 pages hit a dead pool at once. The
// banner is the "one source of truth" for system state.

import { useTranslations } from "next-intl";
import { useHealthStore } from "@/lib/health-store";
import { ApiError, traceCodeFromTraceId } from "@/lib/api";
import { resolveError } from "@/lib/errors/resolve";
import { ErrorBanner } from "@/components/errors";

export function HealthBanner() {
  const status = useHealthStore((s) => s.status);
  const code = useHealthStore((s) => s.code);
  const traceId = useHealthStore((s) => s.traceId);
  const setOk = useHealthStore((s) => s.setOk);
  const t = useTranslations();

  if (status !== "degraded") return null;

  // Synthesise an ApiError so the existing matrix maps it to the right
  // copy. Code defaults to DB_UNAVAILABLE because that's the most
  // common degraded scenario; the actual code (if the gateway shipped
  // one) wins.
  const synthErr = new ApiError(503, t("errors.system.dbUnavailable.title"), {
    code: code ?? "DB_UNAVAILABLE",
    messageKey: "errors.system.dbUnavailable",
    traceId,
    traceCode: traceId ? traceCodeFromTraceId(traceId) : undefined,
  });
  const resolved = resolveError(synthErr, { page: "generic" });
  // Force surface=banner regardless of what the matrix said — this is
  // the global banner slot, that's what it does.
  resolved.surface = "banner";

  return (
    <ErrorBanner
      resolved={resolved}
      onCta={(cta) => {
        if (cta.id === "dismiss") {
          // Allow the user to silence the banner; next bad response
          // re-arms it. Reflective of the "one source of truth"
          // semantic — clear state, not just hide it.
          setOk();
        } else if (cta.id === "retry") {
          // Reload the current page — coarse but reliable. Any router
          // refresh would still need a network call that might fail.
          if (typeof window !== "undefined") window.location.reload();
        }
      }}
    />
  );
}
