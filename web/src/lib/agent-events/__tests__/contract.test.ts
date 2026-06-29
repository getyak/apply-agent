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

  it("loads the 5 Python-emitted frames", () => {
    expect(events.length).toBe(5);
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "CUSTOM",
      "CUSTOM",
      "CUSTOM",
      "RUN_FINISHED",
    ]);
  });

  it("every frame carries a Relay envelope with a monotonic seq", () => {
    let prev = 0;
    for (const e of events) {
      const m = extractRelayMeta(e);
      expect(m.run_id).toBe("run-fixture-1");
      expect(m.seq).toBeGreaterThan(prev);
      prev = m.seq;
    }
  });

  it("the reducer folds the whole fixture into a coherent step graph", () => {
    const final: ReducerState = events.reduce(
      (s, e) => applyEvent(s, e),
      emptyState(),
    );

    // RUN_STARTED → root run step.
    expect(final.rootStepId).toBe("run-fixture-1");
    expect(final.steps.get("run-fixture-1")?.kind).toBe("run");
    // RUN_FINISHED(success) closed it.
    expect(final.steps.get("run-fixture-1")?.status).toBe("done");

    // CUSTOM relay.task_graph → a plan step with two rows.
    const plan = final.steps.get("plan:tg1");
    expect(plan?.kind).toBe("plan");
    expect(plan?.plan?.steps).toHaveLength(2);

    // CUSTOM relay.narrator (step_id=step-narrator-1) → a narrator step.
    const narrator = final.steps.get("custom:step-narrator-1");
    expect(narrator?.kind).toBe("narrator");
    expect(narrator?.narrator?.text).toContain("matches");

    // CUSTOM relay.agent_start (step_id=step-agent-1) → an agent tool step.
    const agent = final.steps.get("agent:step-agent-1");
    expect(agent?.kind).toBe("tool");
    expect(agent?.tool?.name).toBe("jobmatch_agent");
  });
});
