// Step 2 — verifies `formatElapsed` (the pure prose-formatter that powers
// the live "Thinking · 1.4s" chip) handles every band of the dock's expected
// duration range.
//
// `useElapsedMs` itself is a thin useState/useEffect over the same number,
// driven by an injectable clock + scheduler; verifying the formatter +
// AUTO_EXPAND_AFTER_MS contract is enough to lock the chip behaviour down
// without dragging happy-dom + @testing-library/react into the web app for
// one feature.

import { describe, expect, it } from "bun:test";
import { AUTO_EXPAND_AFTER_MS, formatElapsed } from "./use-elapsed";

describe("formatElapsed", () => {
  it("returns 0.0s for 0 / negative / NaN", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(-1)).toBe("0.0s");
    expect(formatElapsed(Number.NaN)).toBe("0.0s");
  });

  it("uses 1-decimal seconds below 10s", () => {
    expect(formatElapsed(100)).toBe("0.1s");
    expect(formatElapsed(1_400)).toBe("1.4s");
    expect(formatElapsed(9_900)).toBe("9.9s");
  });

  it("drops the decimal between 10s and 60s", () => {
    expect(formatElapsed(10_000)).toBe("10s");
    expect(formatElapsed(17_400)).toBe("17s");
    expect(formatElapsed(59_000)).toBe("59s");
  });

  it("switches to m + s above 60s", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(72_500)).toBe("1m 13s");
    expect(formatElapsed(182_000)).toBe("3m 2s");
  });

  it("rolls over correctly at the minute boundary", () => {
    // 119_500ms → 119.5s; the formatter rounds the remainder. Whatever
    // it produces, the shape must stay well-formed: "Nm Rs" with R in
    // [0..59] so we never render "1m 60s".
    const out = formatElapsed(119_500);
    expect(out).toMatch(/^\d+m \d+s$/);
    const [m, rem] = out.split(" ");
    expect(Number(m.replace("m", ""))).toBeGreaterThanOrEqual(1);
    expect(Number(rem.replace("s", ""))).toBeLessThan(60);
  });
});

describe("AUTO_EXPAND_AFTER_MS", () => {
  it("is 8 seconds", () => {
    // Pinned: the dock's auto-expand behaviour is part of the Step 2
    // contract. If anyone changes this, they need to update the dock
    // visual regression + adjust this threshold deliberately.
    expect(AUTO_EXPAND_AFTER_MS).toBe(8_000);
  });
});
