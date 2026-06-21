// Tests for the next_action reconcile script (P3.2-cron).
//
// We don't need PG to verify the meat: parseFlags is pure and we mock
// `../db.query` so the reconcile loop runs against a synthetic dataset.
// The full drift-detect / pagination / dry-run paths get one test
// each — the priority logic is already covered by applications.test.ts.

import { describe, expect, it, mock, beforeEach } from "bun:test";

// ─── Mock layer ───────────────────────────────────────────────────────
// `reconcile-next-action.ts` imports `../db`. We swap that module out
// before importing the module under test so our stub catches every
// query() call. Tests reset `calls` between runs so cross-test leakage
// is impossible. We also stash a reference to the rows the stub should
// return so each test can declare its own dataset cleanly.

interface StubCall {
  text: string;
  params: unknown[] | undefined;
}
const calls: StubCall[] = [];
let nextResults: unknown[][] = [];

mock.module("../db", () => ({
  query: async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = (nextResults.shift() ?? []) as unknown[];
    return { rows };
  },
}));

// Now import under test (AFTER mock.module has registered).
const { reconcile, parseFlags } = await import("./reconcile-next-action");

beforeEach(() => {
  calls.length = 0;
  nextResults = [];
});

// ─── parseFlags ───────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("defaults: dryRun=false, pageSize=500, userId undefined", () => {
    expect(parseFlags([])).toEqual({ dryRun: false, pageSize: 500 });
  });

  it("honours --dry-run", () => {
    expect(parseFlags(["--dry-run"]).dryRun).toBe(true);
  });

  it("honours --user", () => {
    expect(parseFlags(["--user", "abc-123"]).userId).toBe("abc-123");
  });

  it("clamps oversized --page-size down to 5000", () => {
    expect(parseFlags(["--page-size", "100000"]).pageSize).toBe(5000);
  });

  it("falls back to default when --page-size is 0 or garbage", () => {
    // `0` and `"not-a-number"` both fall through `Number.parseInt(...) || 500`
    // so the user can't accidentally disable the cursor by passing zero.
    expect(parseFlags(["--page-size", "0"]).pageSize).toBe(500);
    expect(parseFlags(["--page-size", "not-a-number"]).pageSize).toBe(500);
  });
});

// ─── reconcile loop ───────────────────────────────────────────────────

describe("reconcile", () => {
  it("skips rows already in sync — zero UPDATE queries fired", async () => {
    nextResults = [
      [
        {
          id: "a",
          status: "draft",
          submitted_at: null,
          interview_date: null,
          outcome: null,
          // already matches deriveNextAction's output for status=draft
          next_action: "prep",
          next_action_due: null,
        },
      ],
      // cursor lookup
      [{ created_at: new Date().toISOString() }],
      // next page empty → exit
      [],
    ];
    const summary = await reconcile({ dryRun: false, pageSize: 100 });
    expect(summary.scanned).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.updated).toBe(0);
    // No UPDATE call should have been emitted.
    expect(calls.some((c) => /UPDATE application_drafts/.test(c.text))).toBe(false);
  });

  it("dry-run logs but does not UPDATE", async () => {
    nextResults = [
      [
        {
          id: "b",
          status: "draft",
          submitted_at: null,
          interview_date: null,
          outcome: null,
          next_action: null, // drift: derived=prep, db=null
          next_action_due: null,
        },
      ],
      [{ created_at: new Date().toISOString() }],
      [],
    ];
    const summary = await reconcile({ dryRun: true, pageSize: 100 });
    expect(summary.updated).toBe(1);
    expect(calls.some((c) => /UPDATE application_drafts/.test(c.text))).toBe(false);
  });

  it("UPDATEs drifted rows when not dry-run", async () => {
    nextResults = [
      [
        {
          id: "c",
          status: "draft",
          submitted_at: null,
          interview_date: null,
          outcome: null,
          next_action: null,
          next_action_due: null,
        },
      ],
      [{ created_at: new Date().toISOString() }],
      [],
    ];
    const summary = await reconcile({ dryRun: false, pageSize: 100 });
    expect(summary.updated).toBe(1);
    const updateCalls = calls.filter((c) => /UPDATE application_drafts/.test(c.text));
    expect(updateCalls).toHaveLength(1);
    // Params order: [want_action, want_due, id]
    expect(updateCalls[0].params).toEqual(["prep", null, "c"]);
  });
});
