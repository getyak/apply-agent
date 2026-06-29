/**
 * consumer.ts — the AG-UI SSE consumer. Replaces the hand-rolled NDJSON
 * reader in the now-deleted ask-stream.ts.
 *
 * Why @ag-ui/client (and not CopilotKit / a custom reader)
 * --------------------------------------------------------
 * The plan (agent-event-stream.md §7.2) calls for the official AG-UI SSE
 * parser without the CopilotKit React layer. `@ag-ui/client` ships the
 * parser as an RxJS pipeline: runHttpRequest(fetchThunk) emits raw HTTP
 * chunks, transformHttpEventStream decodes the `data:` frames into typed
 * AG-UI BaseEvents. We subscribe, hand each event to the reducer via the
 * onEvent callback, and own auth / trace / abort here.
 *
 * The gateway (api/src/routes/ask.ts, PR2) is a pure pass-through, so the
 * frames we receive are exactly what agents/harness/events.py emitted —
 * including the Relay envelope in `rawEvent` (see schema.ts:RelayMeta).
 *
 * Caller: web/src/lib/agent-events/store.ts (sendAsk / sendResume).
 */

import { runHttpRequest, transformHttpEventStream } from "@ag-ui/client";
import type { Subscription } from "rxjs";

import { getToken } from "@/lib/api";
import { getClientLocale } from "@/i18n/locale-client";
import { API_BASE } from "@/lib/api-base";
import type { AgentEvent } from "./schema";

export interface ConsumerCallbacks {
  onEvent: (event: AgentEvent) => void;
  onError: (err: Error) => void;
  onDone: () => void;
}

export interface ConsumeArgs {
  /** Request body — `{prompt, thread_id, ...}` or `{thread_id, command}`. */
  body: Record<string, unknown>;
  callbacks: ConsumerCallbacks;
  abortController: AbortController;
}

function endpoint(): string {
  return `${API_BASE}/api/ask/stream`;
}

/**
 * Open one AG-UI turn against POST /api/ask/stream and dispatch every parsed
 * event through `callbacks.onEvent`. Resolves when the stream completes,
 * errors, or is aborted. Never throws — failures go through onError.
 */
export function consumeAgentStream({
  body,
  callbacks,
  abortController,
}: ConsumeArgs): Promise<void> {
  const token = getToken();
  const locale = getClientLocale();

  const fetchThunk = () =>
    fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // AG-UI is SSE — ask the gateway/agents for event-stream framing.
        Accept: "text/event-stream",
        "X-Relay-Locale": locale,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...body, locale }),
      signal: abortController.signal,
    });

  return new Promise<void>((resolve) => {
    let sub: Subscription | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      resolve();
    };

    // Abort → tear the subscription down and resolve cleanly. We treat an
    // intentional abort as "done", not "error" (matches the old reader,
    // which swallowed AbortError).
    const onAbort = () => {
      sub?.unsubscribe();
      finish(callbacks.onDone);
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const http$ = runHttpRequest(fetchThunk);
      const events$ = transformHttpEventStream(http$);
      sub = events$.subscribe({
        next: (evt) => {
          // The parser yields AG-UI BaseEvents (camelCase top-level + a
          // `rawEvent` Relay envelope). Structurally these are our AgentEvent.
          callbacks.onEvent(evt as unknown as AgentEvent);
        },
        error: (err: unknown) => {
          abortController.signal.removeEventListener("abort", onAbort);
          // An abort surfaces here as an AbortError — treat as a clean stop.
          if (err instanceof DOMException && err.name === "AbortError") {
            finish(callbacks.onDone);
            return;
          }
          const e = err instanceof Error ? err : new Error(String(err));
          finish(() => callbacks.onError(e));
        },
        complete: () => {
          abortController.signal.removeEventListener("abort", onAbort);
          finish(callbacks.onDone);
        },
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      finish(() => callbacks.onError(e));
    }
  });
}
