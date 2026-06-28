// Global health store — tracks whether the gateway has flagged the
// stack as "degraded" via the X-Relay-Health response header. The
// banner reads this; any 2xx response with the header absent / set to
// "ok" clears it.
//
// We keep this OUT of lib/store.ts (the big workspace store) so a
// health change doesn't trigger a re-render of every panel that
// happens to subscribe to that store. One small store, one consumer.

import { create } from "zustand";

interface HealthState {
  status: "ok" | "degraded";
  /**
   * Optional code that triggered the degradation (e.g. DB_UNAVAILABLE,
   * CACHE_UNAVAILABLE). Lets the banner pick a more specific title /
   * body, falling back to a generic "system degraded" copy when absent.
   */
  code?: string;
  /**
   * Trace id of the response that flipped us into degraded mode. Surfaces
   * in the banner so support has a ref when the user reports the visit.
   */
  traceId?: string;
  /** When the current state was last updated (ISO). */
  updatedAt: string;
  setDegraded: (code?: string, traceId?: string) => void;
  setOk: () => void;
}

export const useHealthStore = create<HealthState>((set) => ({
  status: "ok",
  updatedAt: new Date(0).toISOString(),
  setDegraded: (code, traceId) =>
    set({
      status: "degraded",
      code,
      traceId,
      updatedAt: new Date().toISOString(),
    }),
  setOk: () =>
    set((s) =>
      s.status === "ok"
        ? s
        : {
            status: "ok",
            code: undefined,
            traceId: undefined,
            updatedAt: new Date().toISOString(),
          },
    ),
}));

/**
 * Called by api-client on every response. The two states correspond to
 * the X-Relay-Health header values defined by the gateway in
 * api/src/errors.ts (the DEGRADED_CODES set drives "degraded"; absent
 * means "no opinion" so we don't auto-clear — let a clean 2xx do it).
 */
export function reportApiHealth(
  status: "ok" | "degraded" | undefined,
  meta?: { code?: string; traceId?: string },
) {
  if (status === "degraded") {
    useHealthStore.getState().setDegraded(meta?.code, meta?.traceId);
  } else if (status === "ok") {
    useHealthStore.getState().setOk();
  }
  // undefined → leave whatever state we're in. The api-client only sees
  // "degraded" (gateway sets it explicitly) or no header (most 2xx) —
  // so we treat any clean 2xx as a positive signal and clear via the
  // call site (see api.ts apiOnce).
}
