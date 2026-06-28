"use client";

// Route-segment error boundary. Wraps every page under /app (and the
// landing tree) — catches React render-time errors and shows the
// localised <ErrorFullPage /> with a Retry CTA. The Next 16.2 docs
// recommend `unstable_retry` over `reset` for transient failures; we
// expose both via the same CTA so a future stable API swap is one
// line. Server errors that bubble up here arrive as a generic Error
// with a `digest` we use as the support reference if no traceId is
// available.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { resolveError } from "@/lib/errors/resolve";
import { ErrorFullPage } from "@/components/errors";

export default function ErrorBoundary({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry?: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // Mirror to console + future telemetry pipe (W5.2 wires the
    // error_shown event here). Don't surface the raw message to the
    // user — resolveError handles the user-facing copy.
    console.error("[error.tsx]", error);
  }, [error]);

  // If this is an ApiError that bubbled up to a render (rare —
  // usually we catch them at the call site), resolveError gives us
  // the right surface row. For a generic render error we synthesise
  // an INTERNAL ResolvedError carrying the React `digest` as the
  // trace fallback so support has SOMETHING to grep on.
  const apiErr =
    error instanceof ApiError
      ? error
      : new ApiError(0, error.message || "Render failed", {
          code: "INTERNAL",
          messageKey: "errors.system.internal",
          traceId: error.digest, // not a real trace; fine for grep
        });
  const resolved = resolveError(apiErr, { page: "generic" });

  return (
    <ErrorFullPage
      resolved={resolved}
      onCta={(cta) => {
        if (cta.id === "retry") {
          if (unstable_retry) unstable_retry();
          else reset();
        } else if (cta.id === "report") {
          // No-op for now — W5.2 will hook this to a telemetry event.
          // The Copy details button on the page is the practical path
          // until then.
        } else if (cta.id === "reauth") {
          router.push("/auth");
        }
      }}
    />
  );
}
