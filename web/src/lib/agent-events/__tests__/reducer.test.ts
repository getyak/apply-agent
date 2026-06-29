// Unit tests for the AG-UI reducer (reducer.ts + custom.ts). These run in
// bun:test without a DOM — the fold is pure. We exercise every event type's
// step-state-machine transition and the CUSTOM (relay.*) routing.
//
// Why this matters: the reducer is the single source of truth for what the
// dock renders; a regression here silently breaks every card.

import { describe, expect, it } from "bun:test";
import { applyEvent, emptyState, type ReducerState } from "../reducer";
import type { AgentEvent, Step } from "../schema";

// Build a Relay meta envelope for an event (mirrors agents/harness/events.py).
let seq = 0;
function meta(extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `01ULID${seq}`,
    seq,
    trace_id: "trace-test",
    run_id: "run-test",
    thread_id: "ask_vantage:test",
    protocol_version: "agui-test+relay-1",
    ...extra,
  };
}

function fold(events: AgentEvent[]): ReducerState {
  return events.reduce((s, e) => applyEvent(s, e), emptyState());
}

function get(s: ReducerState, id: string): Step {
  const step = s.steps.get(id);
  if (!step) throw new Error(`missing step ${id}`);
  return step;
}

describe("run lifecycle", () => {
  it("RUN_STARTED creates the root run step and sets rootStepId", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
    ]);
    expect(s.rootStepId).toBe("run-test");
    expect(get(s, "run-test").kind).toBe("run");
    expect(get(s, "run-test").status).toBe("running");
  });

  it("RUN_FINISHED success closes the root step", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "RUN_FINISHED", threadId: "t", runId: "run-test", outcome: { type: "success" }, rawEvent: meta() } as AgentEvent,
    ]);
    expect(get(s, "run-test").status).toBe("done");
    expect(typeof get(s, "run-test").duration_ms).toBe("number");
  });

  it("RUN_ERROR marks the root step failed", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "RUN_ERROR", message: "boom", code: "INTERNAL", rawEvent: meta() } as AgentEvent,
    ]);
    expect(get(s, "run-test").status).toBe("failed");
  });

  it("RUN_FINISHED interrupt spawns one hitl step per interrupt", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      {
        type: "RUN_FINISHED",
        threadId: "t",
        runId: "run-test",
        outcome: {
          type: "interrupt",
          interrupts: [
            { id: "i1", reason: "approval", message: "Submit?", metadata: { kind: "approval", action: "submit_form" } },
          ],
        },
        rawEvent: meta(),
      } as AgentEvent,
    ]);
    const hitl = get(s, "hitl:i1");
    expect(hitl.kind).toBe("hitl");
    expect(hitl.status).toBe("review");
    expect(hitl.hitl?.interruptId).toBe("i1");
    expect((hitl.hitl?.metadata as Record<string, unknown>)?.action).toBe("submit_form");
  });
});

describe("reasoning", () => {
  it("REASONING_MESSAGE_* accumulates reasoning_text and closes", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "REASONING_MESSAGE_START", messageId: "m1", rawEvent: meta() } as AgentEvent,
      { type: "REASONING_MESSAGE_CONTENT", messageId: "m1", delta: "Let me ", rawEvent: meta() } as AgentEvent,
      { type: "REASONING_MESSAGE_CONTENT", messageId: "m1", delta: "think.", rawEvent: meta() } as AgentEvent,
      { type: "REASONING_MESSAGE_END", messageId: "m1", rawEvent: meta() } as AgentEvent,
    ]);
    const step = get(s, "msg:m1");
    expect(step.kind).toBe("thinking");
    expect(step.reasoning_text).toBe("Let me think.");
    expect(step.status).toBe("done");
  });
});

describe("assistant text", () => {
  it("TEXT_MESSAGE_* accumulates text and closes", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "TEXT_MESSAGE_START", messageId: "t1", role: "assistant", rawEvent: meta() } as AgentEvent,
      { type: "TEXT_MESSAGE_CONTENT", messageId: "t1", delta: "Hello", rawEvent: meta() } as AgentEvent,
      { type: "TEXT_MESSAGE_CONTENT", messageId: "t1", delta: " world", rawEvent: meta() } as AgentEvent,
      { type: "TEXT_MESSAGE_END", messageId: "t1", rawEvent: meta() } as AgentEvent,
    ]);
    const step = get(s, "msg:t1");
    expect(step.kind).toBe("assistant_text");
    expect(step.text).toBe("Hello world");
    expect(step.status).toBe("done");
  });
});

describe("tool calls", () => {
  it("TOOL_CALL_START/ARGS/RESULT builds a tool step with parsed args + result", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search_jobs", rawEvent: meta() } as AgentEvent,
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"q":"go', rawEvent: meta() } as AgentEvent,
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '"}', rawEvent: meta() } as AgentEvent,
      { type: "TOOL_CALL_END", toolCallId: "tc1", rawEvent: meta() } as AgentEvent,
      { type: "TOOL_CALL_RESULT", toolCallId: "tc1", messageId: "rm1", content: '{"items":[1,2,3]}', rawEvent: meta() } as AgentEvent,
    ]);
    const step = get(s, "tool:tc1");
    expect(step.kind).toBe("tool");
    expect(step.status).toBe("done");
    expect(step.tool?.name).toBe("search_jobs");
    expect((step.tool?.args as Record<string, unknown>)?.q).toBe("go");
    expect((step.tool?.result as Record<string, unknown>)?.items).toEqual([1, 2, 3]);
  });
});

describe("CUSTOM routing", () => {
  it("relay.task_graph builds a plan step with normalized statuses", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      {
        type: "CUSTOM",
        name: "relay.task_graph",
        value: {
          task_id: "tg1",
          user_goal: "Find roles",
          plan: [
            { step: 1, agent: "jobmatch_agent", label: "Search", status: "pending" },
            { step: 2, agent: "resume_agent", label: "Tailor", requires_review: true },
          ],
        },
        rawEvent: meta(),
      } as AgentEvent,
    ]);
    const plan = get(s, "plan:tg1").plan!;
    expect(plan.userGoal).toBe("Find roles");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].status).toBe("pending");
    expect(plan.steps[1].requiresReview).toBe(true);
  });

  it("relay.task_graph_step advances a plan row without walking back terminals", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      {
        type: "CUSTOM",
        name: "relay.task_graph",
        value: { task_id: "tg1", plan: [{ step: 1, agent: "a", label: "x" }] },
        rawEvent: meta(),
      } as AgentEvent,
      { type: "CUSTOM", name: "relay.task_graph_step", value: { task_id: "tg1", step: 1, status: "done" }, rawEvent: meta() } as AgentEvent,
      { type: "CUSTOM", name: "relay.task_graph_step", value: { task_id: "tg1", step: 1, status: "running" }, rawEvent: meta() } as AgentEvent,
    ]);
    expect(get(s, "plan:tg1").plan!.steps[0].status).toBe("done");
  });

  it("relay.narrator creates a narrator step", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "CUSTOM", name: "relay.narrator", value: { text: "Looking…" }, rawEvent: meta({ step_id: "n1" }) } as AgentEvent,
    ]);
    expect(get(s, "custom:n1").kind).toBe("narrator");
    expect(get(s, "custom:n1").narrator?.text).toBe("Looking…");
  });

  it("relay.agent_start/done builds and completes an agent tool step", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "CUSTOM", name: "relay.agent_start", value: { agent: "jobmatch_agent", label: "Search" }, rawEvent: meta({ step_id: "a1" }) } as AgentEvent,
      { type: "CUSTOM", name: "relay.agent_done", value: { agent: "jobmatch_agent" }, rawEvent: meta({ step_id: "a1" }) } as AgentEvent,
    ]);
    expect(get(s, "agent:a1").status).toBe("done");
  });

  it("relay.file_edit.preview then relay.file_edit group under one step", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      {
        type: "CUSTOM",
        name: "relay.file_edit.preview",
        value: { path: "resume:r1#b2", before: "old", after: "new" },
        rawEvent: meta({ step_id: "f1" }),
      } as AgentEvent,
      {
        type: "CUSTOM",
        name: "relay.file_edit",
        value: { path: "resume:r1#b2", language: "markdown", hunks: [{ before: "old", after: "new" }], applied: true },
        rawEvent: meta({ step_id: "f1" }),
      } as AgentEvent,
    ]);
    const step = get(s, "file:f1");
    expect(step.kind).toBe("file_edit");
    expect(step.status).toBe("done");
    expect(step.file?.applied).toBe(true);
    expect(step.file?.hunks[0].after).toBe("new");
  });

  it("relay.browser_snapshot + browser_action accumulate on one browser step", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      {
        type: "CUSTOM",
        name: "relay.browser_snapshot",
        value: { url: "https://jobs.example/apply", screenshot_url: "s://1", viewport: { w: 1280, h: 720 } },
        rawEvent: meta({ step_id: "b1" }),
      } as AgentEvent,
      {
        type: "CUSTOM",
        name: "relay.browser_action",
        value: { action: "fill", target: "email", value: "x@y.z" },
        rawEvent: meta({ step_id: "b1" }),
      } as AgentEvent,
    ]);
    const step = get(s, "browser:b1");
    expect(step.kind).toBe("browser");
    expect(step.browser?.snapshots).toHaveLength(1);
    expect(step.browser?.actions[0].action).toBe("fill");
  });

  it("relay.partial_artifact then relay.artifact supersede on one step", () => {
    const s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "CUSTOM", name: "relay.partial_artifact", value: { artifact_id: "art1", title: "Drafting", payload: { items: ["a"] } }, rawEvent: meta() } as AgentEvent,
      { type: "CUSTOM", name: "relay.artifact", value: { artifact_id: "art1", title: "Cover letter", payload: { items: ["a", "b"] } }, rawEvent: meta() } as AgentEvent,
    ]);
    const step = get(s, "artifact:art1");
    expect(step.kind).toBe("artifact");
    expect(step.status).toBe("done");
    expect(step.title).toBe("Cover letter");
  });

  it("unknown relay.* name is dropped onto root feed, not rendered as a step", () => {
    const before = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
    ]);
    const after = applyEvent(before, {
      type: "CUSTOM",
      name: "relay.brand_new_thing",
      value: { foo: 1 },
      rawEvent: meta(),
    } as unknown as AgentEvent);
    // No new step id beyond the root.
    expect(after.order).toEqual(["run-test"]);
    // The event landed on the root feed.
    expect(after.steps.get("run-test")!.events.length).toBeGreaterThan(1);
  });
});

describe("events soft cap", () => {
  it("caps a step's events feed at the soft limit", () => {
    let s = fold([
      { type: "RUN_STARTED", threadId: "t", runId: "run-test", rawEvent: meta() } as AgentEvent,
      { type: "TEXT_MESSAGE_START", messageId: "t1", role: "assistant", rawEvent: meta() } as AgentEvent,
    ]);
    for (let i = 0; i < 400; i++) {
      s = applyEvent(s, { type: "TEXT_MESSAGE_CONTENT", messageId: "t1", delta: "x", rawEvent: meta() } as AgentEvent);
    }
    // Soft cap is 200; head 50 + sentinel + tail 50 (+ the just-appended one).
    expect(get(s, "msg:t1").events.length).toBeLessThanOrEqual(120);
  });
});
