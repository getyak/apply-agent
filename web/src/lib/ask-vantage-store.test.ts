// Step 4 — verifies `updateTaskGraphStepById` only mutates the row whose
// step id matches, never crosses to siblings, and respects terminal
// transitions ("done" / "failed" don't get walked back to "running").
//
// We deliberately exercise the store directly (no React) so the unit test
// doesn't depend on happy-dom or @testing-library; the store is pure
// zustand and works in a node/bun runtime as long as we don't render.

import { afterEach, describe, expect, it } from "bun:test";
import { useDock } from "./ask-vantage-store";

function reset() {
  useDock.setState((s) => ({
    ...s,
    messages: [],
    agentEvents: {},
  }));
}

afterEach(() => reset());

function pushPlan() {
  const id = useDock.getState().pushMessage({
    kind: "task_graph",
    taskId: "p-1",
    userGoal: "test",
    steps: [
      { step: "fetch", agent: "jobmatch_agent", label: "Fetch JD", requires_review: false, status: "pending" },
      { step: "tailor", agent: "resume_agent", label: "Tailor", requires_review: true, status: "pending" },
      { step: "tailor_again", agent: "resume_agent", label: "Second pass", requires_review: false, status: "pending" },
    ],
  });
  return id;
}

describe("upsertPartialArtifact", () => {
  it("pushes a new partial_artifact message on first call", () => {
    const id = useDock.getState().upsertPartialArtifact({
      artifactId: "tailor-1",
      artifactKind: "resume_bullet",
      title: "Drafting",
      sub: "Bullet 1 of 3",
      progress: 0.33,
      payload: { items: ["Bullet 1"] },
    });
    const msgs = useDock.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe(id);
    expect(msgs[0].kind).toBe("partial_artifact");
    expect(msgs[0].partialArtifactId).toBe("tailor-1");
    expect(msgs[0].partialProgress).toBe(0.33);
  });

  it("merges subsequent updates with the same artifactId in place", () => {
    const first = useDock.getState().upsertPartialArtifact({
      artifactId: "tailor-1",
      artifactKind: "resume_bullet",
      title: "Drafting",
      sub: "Bullet 1 of 3",
      progress: 0.33,
      payload: { items: ["B1"] },
    });
    const second = useDock.getState().upsertPartialArtifact({
      artifactId: "tailor-1",
      artifactKind: "resume_bullet",
      title: "Drafting",
      sub: "Bullet 2 of 3",
      progress: 0.66,
      payload: { items: ["B1", "B2"] },
    });
    expect(first).toBe(second);
    const msgs = useDock.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].partialSub).toBe("Bullet 2 of 3");
    expect(msgs[0].partialProgress).toBe(0.66);
    expect((msgs[0].partialPayload as { items: string[] }).items).toEqual([
      "B1",
      "B2",
    ]);
  });

  it("treats a different artifactId as a separate card", () => {
    useDock.getState().upsertPartialArtifact({
      artifactId: "tailor-1",
      artifactKind: "resume_bullet",
    });
    useDock.getState().upsertPartialArtifact({
      artifactId: "cover-1",
      artifactKind: "cover_letter",
    });
    const msgs = useDock.getState().messages;
    expect(msgs.length).toBe(2);
    const ids = new Set(msgs.map((m) => m.partialArtifactId));
    expect(ids).toEqual(new Set(["tailor-1", "cover-1"]));
  });
});

describe("updateTaskGraphStepById", () => {
  it("marks the matching step running", () => {
    const id = pushPlan();
    useDock.getState().updateTaskGraphStepById(id, "tailor", "running");
    const msg = useDock.getState().messages.find((m) => m.id === id)!;
    expect(msg.steps?.find((s) => s.step === "tailor")?.status).toBe("running");
    // Siblings untouched.
    expect(msg.steps?.find((s) => s.step === "fetch")?.status).toBe("pending");
    expect(msg.steps?.find((s) => s.step === "tailor_again")?.status).toBe("pending");
  });

  it("distinguishes two steps that share the same agent", () => {
    const id = pushPlan();
    useDock.getState().updateTaskGraphStepById(id, "tailor", "done");
    useDock.getState().updateTaskGraphStepById(id, "tailor_again", "running");
    const msg = useDock.getState().messages.find((m) => m.id === id)!;
    expect(msg.steps?.find((s) => s.step === "tailor")?.status).toBe("done");
    expect(msg.steps?.find((s) => s.step === "tailor_again")?.status).toBe("running");
  });

  it("does not walk back from 'done' to 'running'", () => {
    const id = pushPlan();
    useDock.getState().updateTaskGraphStepById(id, "fetch", "done");
    useDock.getState().updateTaskGraphStepById(id, "fetch", "running");
    const msg = useDock.getState().messages.find((m) => m.id === id)!;
    expect(msg.steps?.find((s) => s.step === "fetch")?.status).toBe("done");
  });

  it("is a no-op for unknown stepId / msgId / non-task_graph messages", () => {
    const id = pushPlan();
    // Unknown step id — no throw, no change.
    useDock.getState().updateTaskGraphStepById(id, "nope", "running");
    const msg = useDock.getState().messages.find((m) => m.id === id)!;
    expect(msg.steps?.every((s) => s.status === "pending")).toBe(true);
    // Unknown message id.
    expect(() =>
      useDock.getState().updateTaskGraphStepById("missing", "fetch", "running"),
    ).not.toThrow();
  });
});

describe("appendReasoning", () => {
  it("appends onto the most recently started running agent event", () => {
    useDock.getState().updateAgentEvent({
      id: "evt-1",
      agent: "coordinator",
      label: "COORDINATOR · thinking",
      state: "running",
      statusText: "Thinking",
      ts: 100,
    });
    useDock.getState().updateAgentEvent({
      id: "evt-2",
      agent: "jobmatch_agent",
      label: "SCOUT AGENT · thinking",
      state: "running",
      statusText: "Thinking",
      ts: 200,
    });
    useDock.getState().appendReasoning("first chunk");
    useDock.getState().appendReasoning(" second chunk");
    const evt2 = useDock.getState().agentEvents["evt-2"];
    expect(evt2.reasoningText).toBe("first chunk second chunk");
    const evt1 = useDock.getState().agentEvents["evt-1"];
    expect(evt1.reasoningText).toBeUndefined();
  });

  it("ignores reasoning when no agent is running", () => {
    useDock.getState().updateAgentEvent({
      id: "evt-done",
      agent: "coordinator",
      label: "COORDINATOR · done",
      state: "done",
      statusText: "Done · 1.2s",
      ts: 300,
    });
    expect(() =>
      useDock.getState().appendReasoning("orphan reasoning"),
    ).not.toThrow();
    const evt = useDock.getState().agentEvents["evt-done"];
    expect(evt.reasoningText).toBeUndefined();
  });

  it("drops empty text without mutating state", () => {
    useDock.getState().updateAgentEvent({
      id: "evt-3",
      agent: "coordinator",
      label: "COORDINATOR · thinking",
      state: "running",
      statusText: "Thinking",
      ts: 400,
    });
    useDock.getState().appendReasoning("");
    const evt = useDock.getState().agentEvents["evt-3"];
    expect(evt.reasoningText).toBeUndefined();
  });
});
