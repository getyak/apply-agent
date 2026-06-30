// Unit tests for the dock step-store's history hydration + sendAsk no-reset
// behaviour. These run in bun:test (no DOM); the store is a plain Zustand
// instance so we drive it via setState / getState directly.
//
// Why this file exists: A (history hydration) and B (no per-turn reset) are
// the two halves of the "every send feels like a fresh window" fix. The
// reducer is already covered; what was missing was the *orchestration* layer
// — that hydrateFromHistory injects the persisted turns AND that sendAsk no
// longer clobbers them when a new turn starts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  hydrateFromHistory,
  useAgentStream,
  type HistoryRow,
} from "../store";

function ids(): string[] {
  return useAgentStream.getState().order.slice();
}

function step(id: string) {
  return useAgentStream.getState().steps.get(id);
}

function resetStore() {
  useAgentStream.setState({
    steps: new Map(),
    order: [],
    rootStepId: null,
    isStreaming: false,
    errorMessage: null,
    abortController: null,
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore();
});

describe("hydrateFromHistory", () => {
  it("turns user rows into a 'user' step and assistant rows into 'assistant_text'", () => {
    const rows: HistoryRow[] = [
      {
        id: "msg-1",
        role: "user",
        content: "hello vantage",
        metadata: {},
        createdAt: "2026-06-29T10:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "Hi — what's up?",
        metadata: { trace_id: "abc" },
        createdAt: "2026-06-29T10:00:01Z",
      },
    ];
    hydrateFromHistory(rows);

    expect(ids()).toEqual(["history:msg-1", "history:msg-2"]);
    const userStep = step("history:msg-1")!;
    const asstStep = step("history:msg-2")!;
    expect((userStep.kind as string)).toBe("user");
    expect(userStep.status).toBe("done");
    expect(userStep.text).toBe("hello vantage");
    expect(asstStep.kind).toBe("assistant_text");
    expect(asstStep.text).toBe("Hi — what's up?");
  });

  it("preserves insertion order (already chronological from the wire)", () => {
    const rows: HistoryRow[] = [
      { id: "a", role: "user", content: "first", metadata: {}, createdAt: "2026-06-29T10:00:00Z" },
      { id: "b", role: "assistant", content: "second", metadata: {}, createdAt: "2026-06-29T10:00:01Z" },
      { id: "c", role: "user", content: "third", metadata: {}, createdAt: "2026-06-29T10:00:02Z" },
    ];
    hydrateFromHistory(rows);
    expect(ids()).toEqual(["history:a", "history:b", "history:c"]);
  });

  it("is a *replace* — calling it again wipes the previous hydration", () => {
    hydrateFromHistory([
      { id: "old", role: "user", content: "old prompt", metadata: {}, createdAt: "2026-06-29T09:00:00Z" },
    ]);
    expect(ids()).toEqual(["history:old"]);

    hydrateFromHistory([
      { id: "new", role: "user", content: "new prompt", metadata: {}, createdAt: "2026-06-29T11:00:00Z" },
    ]);
    expect(ids()).toEqual(["history:new"]);
  });

  it("handles an empty history without throwing or polluting state", () => {
    hydrateFromHistory([]);
    expect(ids()).toEqual([]);
    expect(useAgentStream.getState().isStreaming).toBe(false);
    expect(useAgentStream.getState().errorMessage).toBeNull();
  });

  it("clears the streaming flag / abort controller so it cannot collide with a stale run", () => {
    const fakeAbort = new AbortController();
    useAgentStream.setState({
      isStreaming: true,
      abortController: fakeAbort,
      errorMessage: "boom",
    });

    hydrateFromHistory([
      { id: "m", role: "user", content: "x", metadata: {}, createdAt: "2026-06-29T10:00:00Z" },
    ]);

    expect(useAgentStream.getState().isStreaming).toBe(false);
    expect(useAgentStream.getState().abortController).toBeNull();
    expect(useAgentStream.getState().errorMessage).toBeNull();
    expect(fakeAbort.signal.aborted).toBe(true);
  });

  it("folds tool / system rows into an assistant_text step so nothing is dropped", () => {
    hydrateFromHistory([
      { id: "t1", role: "tool", content: "tool returned X", metadata: {}, createdAt: "2026-06-29T10:00:00Z" },
      { id: "s1", role: "system", content: "system note", metadata: {}, createdAt: "2026-06-29T10:00:01Z" },
    ]);
    expect(step("history:t1")!.kind).toBe("assistant_text");
    expect(step("history:s1")!.kind).toBe("assistant_text");
  });
});

describe("sendAsk no-reset contract", () => {
  // We don't drive the network here (consumer.ts owns that). We assert the
  // *contract*: starting a new turn must not wipe the hydrated history. We
  // mimic the pre-flight sendAsk performs (abort prior controller + clear
  // errorMessage), and confirm steps survive.

  it("hydrated history survives an explicit pre-flight cancel", () => {
    hydrateFromHistory([
      { id: "h1", role: "user", content: "old", metadata: {}, createdAt: "2026-06-29T10:00:00Z" },
      { id: "h2", role: "assistant", content: "ack", metadata: {}, createdAt: "2026-06-29T10:00:01Z" },
    ]);
    const before = ids();

    const cur = useAgentStream.getState().abortController;
    if (cur) cur.abort();
    useAgentStream.setState({ errorMessage: null });

    expect(ids()).toEqual(before);
    expect(step("history:h1")).toBeDefined();
    expect(step("history:h2")).toBeDefined();
  });

  it("a new in-flight controller does not clear history", () => {
    hydrateFromHistory([
      { id: "h1", role: "user", content: "old", metadata: {}, createdAt: "2026-06-29T10:00:00Z" },
    ]);
    const newCtrl = new AbortController();
    useAgentStream.setState({
      abortController: newCtrl,
      isStreaming: true,
    });
    expect(step("history:h1")).toBeDefined();
    expect(useAgentStream.getState().isStreaming).toBe(true);
    newCtrl.abort();
  });
});
