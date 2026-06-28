"use client";

// Light-touch telemetry pipe — emits structured events to console for
// now, with a stable shape that's ready for a real backend
// (Sentry/PostHog/internal endpoint) the day we wire one in. The error
// presentation components call into here on every mount + every
// "Copy details" click; that gives us a baseline for "which codes are
// users actually seeing, and which are they bothering to report" — the
// two numbers that drive triage priority.

export type TelemetryEvent =
  | {
      name: "error_shown";
      payload: {
        code?: string;
        surface: "inline" | "toast" | "banner" | "full-page";
        page?: string;
        traceId?: string;
        traceCode?: string;
        severity: "info" | "warning" | "error" | "critical";
        // pathname at emission for analytics
        path?: string;
      };
    }
  | {
      name: "error_details_copied";
      payload: {
        code?: string;
        traceId?: string;
        traceCode?: string;
        path?: string;
      };
    }
  | {
      name: "error_cta_clicked";
      payload: {
        ctaId: string;
        code?: string;
        traceId?: string;
        path?: string;
      };
    };

type Listener = (e: TelemetryEvent) => void;

// Single shared dispatcher. Components in W2.4 emit; the future
// Sentry/PostHog integration subscribes here instead of every
// component reimporting an SDK.
const listeners = new Set<Listener>();

export function onTelemetry(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function emitTelemetry(event: TelemetryEvent) {
  // Console line for dev. Stable JSON so log grep is reliable.
  if (typeof console !== "undefined") {
    console.info(
      "[telemetry]",
      JSON.stringify({ name: event.name, ...event.payload }),
    );
  }
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      // never let one bad subscriber kill the dispatch loop
    }
  }
}

/** Convenience for the presentation components — derives `path`
 *  from window.location so each call site doesn't repeat the dance. */
export function currentPath(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname;
}
