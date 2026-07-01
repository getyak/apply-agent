/**
 * consumer.ts — the AG-UI SSE consumer with resume-by-cursor (D4 of the
 * stream-resume-plan) baked in.
 *
 * Why @ag-ui/client (and not CopilotKit / a custom reader)
 * --------------------------------------------------------
 * The plan (agent-event-stream.md §7.2) calls for the official AG-UI SSE
 * parser without the CopilotKit React layer. `@ag-ui/client` ships the
 * parser as an RxJS pipeline: runHttpRequest(fetchThunk) emits raw HTTP
 * chunks, transformHttpEventStream decodes the `data:` frames into typed
 * AG-UI BaseEvents. We subscribe, hand each event to the reducer via the
 * onEvent callback, and own auth / trace / abort / RESUME here.
 *
 * The gateway (api/src/routes/ask.ts) is a pure pass-through, so the
 * frames we receive are exactly what agents/harness/events.py emitted —
 * including the Relay envelope in `rawEvent` (see schema.ts:RelayMeta)
 * augmented with `stream_seq` when the frame was persisted to
 * ask_stream_events (Python-side persist_stream wraps every yielded
 * frame with the per-thread sequence).
 *
 * Resume semantics
 * ----------------
 * Every event we receive potentially carries `event.rawEvent.stream_seq`
 * (a monotonic per-thread cursor). We track the highest one seen. When
 * the underlying fetch fails for network reasons — NOT for user abort,
 * NOT for HTTP 4xx/5xx errors surfaced through onError — we retry up to
 * ``MAX_RECONNECT_ATTEMPTS`` times with exponential backoff, POSTing the
 * same body plus ``last_event_id: <cursor>`` and a ``Last-Event-ID``
 * header. The server's /ask/stream resume branch replays missed frames
 * verbatim; the reducer folds them exactly as if the connection had
 * never dropped.
 *
 * If the server responds with an ``event: stream_expired`` SSE frame
 * (the resume buffer was pruned past our cursor), we fire
 * ``onStreamExpired`` and stop retrying — the UI surfaces
 * "Stream expired · Start over".
 *
 * Caller: web/src/lib/agent-events/store.ts (sendAsk / sendResume).
 */

import { runHttpRequest, transformHttpEventStream } from "@ag-ui/client";
import type { Subscription } from "rxjs";

import { getToken } from "@/lib/api";
import { getClientLocale } from "@/i18n/locale-client";
import { API_BASE } from "@/lib/api-base";
import type { AgentEvent } from "./schema";

// Reconnect backoff schedule (ms). 3 attempts total — anything more
// gives the user the impression the stream is stuck; the UI should
// surface a manual "Retry" affordance instead. These waits sit under
// the prompt cache TTL and match the "brief" band from
// docs/architecture/error-handling.md §5.
const RECONNECT_BACKOFF_MS = [500, 1500, 3500] as const;
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

export interface ConsumerCallbacks {
  onEvent: (event: AgentEvent) => void;
  onError: (err: Error) => void;
  onDone: () => void;
  /**
   * Fired when a transport failure kicks off a reconnect. Called with
   * ``attempt`` = 1..MAX_RECONNECT_ATTEMPTS on each retry, then again
   * with ``attempt = 0`` when the stream re-establishes cleanly (so the
   * UI can clear the "Reconnecting…" affordance). Also called with a
   * negative ``attempt`` when the retry budget is exhausted — the
   * following ``onError`` still fires.
   */
  onReconnect?: (info: { attempt: number; nextDelayMs?: number }) => void;
  /**
   * Fired when the server returns ``event: stream_expired``. Stops all
   * retries; the caller should surface "Stream expired · Start over".
   */
  onStreamExpired?: (info: { traceId?: string; reason?: string }) => void;
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
 * Extract the per-thread stream cursor from a parsed AG-UI event. The
 * Python-side ``persist_stream`` injects it into ``rawEvent.stream_seq``
 * on every persisted frame (heartbeat too). Falls back to ``undefined``
 * on pre-021 frames or frames the parser stripped rawEvent from.
 */
function readStreamSeq(evt: AgentEvent): number | undefined {
  const raw = (evt as unknown as { rawEvent?: Record<string, unknown> })
    .rawEvent;
  if (!raw) return undefined;
  const seq = raw["stream_seq"];
  if (typeof seq === "number" && Number.isFinite(seq) && seq > 0) return seq;
  return undefined;
}

/**
 * Attempt to detect a ``stream_expired`` SSE event. The server emits it
 * as a raw SSE frame outside the AG-UI envelope (``event: stream_expired
 * data: {"traceId":...}``); ag-ui's parser only surfaces the data body
 * with ``type`` = undefined, so we sniff the payload for the
 * ``reason: buffer_evicted`` marker.
 */
function tryReadStreamExpired(
  evt: AgentEvent,
): { traceId?: string; reason?: string } | null {
  const anyEvt = evt as unknown as {
    type?: unknown;
    reason?: unknown;
    traceId?: unknown;
  };
  const reason = anyEvt.reason;
  if (typeof reason === "string" && reason === "buffer_evicted") {
    const traceId =
      typeof anyEvt.traceId === "string" ? anyEvt.traceId : undefined;
    return { traceId, reason };
  }
  return null;
}

/**
 * Open one AG-UI turn against POST /api/ask/stream and dispatch every parsed
 * event through `callbacks.onEvent`. Resolves when the stream completes,
 * errors permanently, or is aborted. Never throws — failures go through onError.
 *
 * Automatic resume-by-cursor on transient transport failure: up to
 * MAX_RECONNECT_ATTEMPTS retries, each with the last-seen ``stream_seq``
 * as the cursor. The caller sees a single logical stream.
 */
export function consumeAgentStream({
  body,
  callbacks,
  abortController,
}: ConsumeArgs): Promise<void> {
  const token = getToken();
  const locale = getClientLocale();

  // Live cursor tracking. Update on every event's rawEvent.stream_seq.
  let lastSeq = 0;
  let attempt = 0;
  let expired = false;

  const buildFetch = (isResume: boolean) => {
    const payload: Record<string, unknown> = { ...body, locale };
    if (isResume && lastSeq > 0) {
      // Body carries the cursor for POST bodies (fetch can't rely on
      // the HTTP EventSource-native ``Last-Event-ID`` header being
      // preserved across all intermediaries).
      payload.last_event_id = lastSeq;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Relay-Locale": locale,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    if (isResume && lastSeq > 0) {
      // ALSO set the header — future EventSource-based transports use
      // it natively. Belt and braces cost nothing.
      headers["Last-Event-ID"] = String(lastSeq);
    }
    return () =>
      fetch(endpoint(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });
  };

  return new Promise<void>((resolve) => {
    let sub: Subscription | null = null;
    let settled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      fn();
      resolve();
    };

    // Abort → tear the subscription down and resolve cleanly. Also
    // cancel any pending reconnect timer.
    const onAbort = () => {
      sub?.unsubscribe();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      finish(callbacks.onDone);
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    const scheduleReconnect = (transportErr: Error) => {
      // Retry budget exhausted → surface the original error.
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        callbacks.onReconnect?.({ attempt: -attempt });
        finish(() => callbacks.onError(transportErr));
        return;
      }
      const delayMs = RECONNECT_BACKOFF_MS[attempt] ?? 3500;
      attempt += 1;
      callbacks.onReconnect?.({ attempt, nextDelayMs: delayMs });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (settled || abortController.signal.aborted) return;
        try {
          openStream(/* isResume */ true);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          finish(() => callbacks.onError(e));
        }
      }, delayMs);
    };

    const openStream = (isResume: boolean) => {
      sub?.unsubscribe();
      const http$ = runHttpRequest(buildFetch(isResume));
      const events$ = transformHttpEventStream(http$);
      sub = events$.subscribe({
        next: (evt) => {
          const event = evt as unknown as AgentEvent;
          // Sniff for the stream_expired signal — a peculiar SSE event
          // outside the AG-UI envelope. Stop the retry loop; the UI
          // shows "Stream expired · Start over".
          const exp = tryReadStreamExpired(event);
          if (exp) {
            expired = true;
            callbacks.onStreamExpired?.(exp);
            return;
          }
          const seq = readStreamSeq(event);
          if (seq !== undefined && seq > lastSeq) {
            lastSeq = seq;
          }
          // Reset the reconnect signal on the first event after a
          // reconnect — the "Reconnecting…" UI can clear.
          if (attempt > 0) {
            callbacks.onReconnect?.({ attempt: 0 });
            attempt = 0;
          }
          callbacks.onEvent(event);
        },
        error: (err: unknown) => {
          // AbortError → user cancel, treat as clean stop, do NOT retry.
          if (err instanceof DOMException && err.name === "AbortError") {
            abortController.signal.removeEventListener("abort", onAbort);
            finish(callbacks.onDone);
            return;
          }
          if (expired) {
            // stream_expired was already surfaced; treat error as done.
            abortController.signal.removeEventListener("abort", onAbort);
            finish(callbacks.onDone);
            return;
          }
          const e = err instanceof Error ? err : new Error(String(err));
          // Transient transport failure → schedule a resume-by-cursor
          // reconnect. Only network/parser errors reach here; HTTP 4xx
          // errors are surfaced by the server as RUN_ERROR frames on
          // the same stream (not the RxJS error path), so this branch
          // exclusively catches "connection dropped mid-frame" flakes.
          scheduleReconnect(e);
        },
        complete: () => {
          abortController.signal.removeEventListener("abort", onAbort);
          finish(callbacks.onDone);
        },
      });
    };

    try {
      openStream(/* isResume */ false);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      finish(() => callbacks.onError(e));
    }
  });
}
