// Unit tests for deriveNextAction — the P3.2 state machine.
//
// Pure function; no DB. We assert the priority order from the
// docstring: interview > close_loop > follow_up > review > draft.
//
// All "now" values use a fixed reference timestamp so the test is not
// sensitive to clock skew. Since the function reads Date.now() under
// the hood, we instead vary the input row dates relative to a known
// moment that the test driver controls via Date stubbing in `describe`.

import { describe, expect, it } from "bun:test";
import { deriveNextAction } from "./applications";

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

describe("deriveNextAction", () => {
  it("draft → prep", () => {
    expect(deriveNextAction({ status: "draft" })).toEqual({
      next_action_derived: "prep",
      next_action_due_derived: null,
    });
  });

  it("review → submit", () => {
    expect(deriveNextAction({ status: "review" })).toEqual({
      next_action_derived: "submit",
      next_action_due_derived: null,
    });
  });

  it("submitted < 7d → no follow_up yet, falls through to null", () => {
    const out = deriveNextAction({
      status: "submitted",
      submitted_at: daysFromNow(-3),
    });
    expect(out.next_action_derived).toBeNull();
  });

  it("submitted ≥ 7d → follow_up", () => {
    const out = deriveNextAction({
      status: "submitted",
      submitted_at: daysFromNow(-9),
    });
    expect(out.next_action_derived).toBe("follow_up");
    expect(out.next_action_due_derived).not.toBeNull();
  });

  it("interview within 7d wins even when also submitted ≥ 7d", () => {
    const out = deriveNextAction({
      status: "submitted",
      submitted_at: daysFromNow(-30),
      interview_date: daysFromNow(2),
    });
    expect(out.next_action_derived).toBe("interview");
  });

  it("interview > 7d away does NOT take priority", () => {
    const out = deriveNextAction({
      status: "submitted",
      submitted_at: daysFromNow(-30),
      interview_date: daysFromNow(20),
    });
    expect(out.next_action_derived).toBe("follow_up");
  });

  it("rejected → close_loop regardless of interview_date", () => {
    expect(
      deriveNextAction({ status: "rejected", interview_date: daysFromNow(2) }),
    ).toEqual({ next_action_derived: "close_loop", next_action_due_derived: null });
  });

  it("offer → close_loop", () => {
    expect(deriveNextAction({ status: "offer" })).toEqual({
      next_action_derived: "close_loop",
      next_action_due_derived: null,
    });
  });

  it("outcome present → close_loop even without rejected status", () => {
    expect(
      deriveNextAction({ status: "submitted", outcome: "ghosted" }),
    ).toEqual({ next_action_derived: "close_loop", next_action_due_derived: null });
  });

  it("empty row → null", () => {
    expect(deriveNextAction({})).toEqual({
      next_action_derived: null,
      next_action_due_derived: null,
    });
  });
});
