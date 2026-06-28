// Step 2 — live duration hook.
//
// Tracks elapsed milliseconds from a fixed `startedAt` timestamp at a chosen
// refresh rate. Used by the dock's AgentCardRow to show "Running · 1.4s"
// instead of a static spinner. Once a row enters a terminal state the caller
// stops the hook (running=false) so the number freezes at the final value.
//
// Why a hook (and not `setInterval` straight in the component): we need the
// hook to be both testable in isolation (renderHook with `vi.useFakeTimers`)
// AND swappable for a deterministic clock at unit-test time. Both the
// `now()` clock and the `schedule()` scheduler are injectable.

import { useEffect, useState } from "react";

export interface UseElapsedOpts {
  /** epoch ms when the underlying work started */
  startedAt: number;
  /** when false, hook stops ticking — freezes the displayed value */
  running: boolean;
  /** refresh interval in ms (default 200ms — fast enough to feel live, slow
   *  enough that React doesn't burn through reconciliations). */
  intervalMs?: number;
  /** test seam: zero-arg clock. Default = Date.now */
  now?: () => number;
  /** test seam: scheduler. Default = setInterval; must return a clear handle. */
  schedule?: (cb: () => void, ms: number) => () => void;
}

const defaultSchedule = (cb: () => void, ms: number): (() => void) => {
  const handle = setInterval(cb, ms);
  return () => clearInterval(handle);
};

export function useElapsedMs(opts: UseElapsedOpts): number {
  const {
    startedAt,
    running,
    intervalMs = 200,
    now = Date.now,
    schedule = defaultSchedule,
  } = opts;
  const [elapsed, setElapsed] = useState<number>(() =>
    Math.max(0, now() - startedAt),
  );

  useEffect(() => {
    // Synchronise immediately on (re)mount / state flip so the first paint
    // doesn't show a stale value from the previous run. This effect *is* the
    // sync between React state and an external clock — exactly the use case
    // react-hooks/set-state-in-effect carves out as legitimate.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync with external Date.now()/setInterval clock.
    setElapsed(Math.max(0, now() - startedAt));
    if (!running) return;
    const cancel = schedule(() => {
      setElapsed(Math.max(0, now() - startedAt));
    }, intervalMs);
    return cancel;
  }, [startedAt, running, intervalMs, now, schedule]);

  return elapsed;
}

// Pretty-print elapsed ms for the dock chip. < 10s shows 1 decimal place
// ("1.4s"), >= 10s drops the decimal ("17s"), >= 60s switches to "1m 12s"
// so long-running ops don't show "182s" which is hard to read at a glance.
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  // Round the whole-second count first, then split — this keeps the
  // seconds component in [0..59] even when the fractional part rounds up
  // past the next minute boundary (119.5s would otherwise render as
  // "1m 60s", which the test below catches).
  const totalSeconds = Math.round(s);
  const m = Math.floor(totalSeconds / 60);
  const rem = totalSeconds - m * 60;
  return `${m}m ${rem}s`;
}

// The threshold the dock uses to auto-expand a running agent card. Exported
// for tests + so the dock can refer to it without redefining the magic
// number. 8 seconds is the audit-derived "user worries it's stuck" mark.
export const AUTO_EXPAND_AFTER_MS = 8_000;
