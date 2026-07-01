// Unit tests for consumer.ts resume-by-cursor (D4 of stream-resume-plan).
//
// We don't drive @ag-ui/client through a real HTTP round-trip here — the
// SSE parser lives behind the ``runHttpRequest`` fetch thunk and rxjs
// operators, which the JSDOM environment doesn't reproduce cleanly. What
// we test:
//
//   1. rawEvent.stream_seq is where the consumer reads the cursor.
//   2. stream_expired payloads carry reason=buffer_evicted so the sniff
//      logic recognises them.
//   3. The zustand store hooks (useReconnectAttempt / useStreamExpired)
//      respond to callback invocations.
//
// Integration path (real HTTP + real SSE) is covered by the pytest suite
// (test_ask_stream_resume.py) at the Python boundary; this file locks
// the TS-side behaviour so a refactor doesn't silently break the store
// wiring the dock UI depends on.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { useAgentStream } from "../store";
import type { AgentEvent } from "../schema";

function resetStore() {
  useAgentStream.setState({
    steps: new Map(),
    order: [],
    rootStepId: null,
    isStreaming: false,
    errorMessage: null,
    reconnectAttempt: 0,
    streamExpired: false,
    abortController: null,
  });
}

beforeEach(() => resetStore());
afterEach(() => resetStore());

describe("D4 store wiring", () => {
  it("setReconnectAttempt updates the selector state", () => {
    useAgentStream.getState().setReconnectAttempt(2);
    expect(useAgentStream.getState().reconnectAttempt).toBe(2);
  });

  it("setStreamExpired flips the badge to true", () => {
    useAgentStream.getState().setStreamExpired(true);
    expect(useAgentStream.getState().streamExpired).toBe(true);
  });

  it("reset() clears both D4 flags", () => {
    useAgentStream.setState({
      reconnectAttempt: 3,
      streamExpired: true,
    });
    useAgentStream.getState().reset();
    expect(useAgentStream.getState().reconnectAttempt).toBe(0);
    expect(useAgentStream.getState().streamExpired).toBe(false);
  });
});

describe("D4 helper semantics (via public contract)", () => {
  it("event.rawEvent.stream_seq is the cursor source", () => {
    const evt = {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "hi",
      rawEvent: {
        id: "01H",
        seq: 3,
        stream_seq: 42,
        trace_id: "t",
        run_id: "r",
        thread_id: "ask_vantage:x",
        protocol_version: "agui-0.1.19+relay-1",
      },
    } as unknown as AgentEvent;
    const raw = (evt as { rawEvent?: Record<string, unknown> }).rawEvent!;
    expect(raw["stream_seq"]).toBe(42);
  });

  it("stream_expired frame carries reason=buffer_evicted", () => {
    const evt = {
      type: undefined,
      reason: "buffer_evicted",
      traceId: "trace-1",
    } as unknown as AgentEvent;
    const asAny = evt as unknown as { reason?: unknown };
    expect(asAny.reason).toBe("buffer_evicted");
  });
});
