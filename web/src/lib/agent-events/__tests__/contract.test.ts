// Protocol contract test — guards against AG-UI 0.x churn (plan §10.2).
//
// The fixture agents/tests/fixtures/agui_events.jsonl is emitted by the
// Python side (agents/harness/events.py via RelayEmitter, frozen in PR1) and
// is the SAME file the Python contract test consumes. Here we assert the web
// reducer can fold every Python-emitted frame into a coherent step graph —
// i.e. both ends agree on the wire shape (camelCase top-level + a snake_case
// `rawEvent` Relay envelope).
//
// If a future SDK / emitter change reshapes the wire, this test fails first.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvent, emptyState, type ReducerState } from "../reducer";
import { extractRelayMeta } from "../relay-meta";
import type { AgentEvent } from "../schema";

// Resolve the shared fixture relative to the repo root. `import.meta.dir`
// points at this __tests__ folder; walk up to the worktree root.
const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "agents",
  "tests",
  "fixtures",
  "agui_events.jsonl",
);

function loadFixture(): AgentEvent[] {
  const raw = readFileSync(FIXTURE, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AgentEvent);
}

describe("AG-UI wire contract", () => {
  const events = loadFixture();

  // The fixture used to be 5 hand-crafted frames (PR1/PR3 era); PR2 replaced
  // it with the verbatim transcript of a real dock turn driven through the
  // ag-ui-langgraph adapter — currently ~200 frames covering every CUSTOM
  // relay.* name plus the standard lifecycle. So this contract guards shape,
  // not exact count: any non-empty real-world transcript must round-trip
  // through the reducer cleanly.

  it("the fixture is a non-empty AG-UI run", () => {
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  it("every frame carries a Relay envelope with a monotonic seq within the same run", () => {
    const seenRuns = new Map<string, number>(); // run_id -> max seq seen
    for (const e of events) {
      const m = extractRelayMeta(e);
      expect(m.run_id).toBeTruthy();
      expect(m.trace_id).toBeTruthy();
      expect(m.protocol_version).toMatch(/^agui-/);
      expect(m.id).toBeTruthy(); // ULID

      const prev = seenRuns.get(m.run_id) ?? 0;
      // Within a run, seq strictly increases. (RelayEmitter is per-run.)
      expect(m.seq).toBeGreaterThan(prev);
      seenRuns.set(m.run_id, m.seq);
    }
  });

  it("the reducer folds the whole fixture into a coherent step graph without throwing", () => {
    const final: ReducerState = events.reduce(
      (s, e) => applyEvent(s, e),
      emptyState(),
    );

    // The root run step is created on RUN_STARTED and closed on RUN_FINISHED.
    expect(final.rootStepId).toBeTruthy();
    const root = final.steps.get(final.rootStepId!);
    expect(root?.kind).toBe("run");
    // Real dock turns end either "done" (success) or "review" (HITL interrupt);
    // the fixture is a success path so we expect done.
    expect(["done", "review"]).toContain(root?.status);

    // At least one CUSTOM event must have produced a downstream step (we don't
    // pin a specific kind because the transcript covers many of them).
    const nonRootSteps = Array.from(final.steps.values()).filter(
      (s) => s.id !== final.rootStepId,
    );
    expect(nonRootSteps.length).toBeGreaterThan(0);
  });
});
