import type { Context, Next } from "hono";
import type { AppEnv } from "../types";

// traceId middleware — sits BEFORE request-id in the chain (see
// docs/architecture/error-handling.md §5). One traceId follows a user
// action through web → api → agents → LLM; one requestId belongs to a
// single HTTP call. A trace can contain multiple requests when SSE
// streams or agent calls fan out.
//
// The traceId is taken from an inbound X-Trace-Id header if present
// (lets the web layer inject its own when relevant; lets us replay
// recorded sessions with stable ids), otherwise generated fresh. We
// echo it back on the response so devtools/Sentry can see it without
// parsing JSON, and the gateway's outbound fetches to agents forward
// the same header (see api/src/lib/agent-fetch.ts, W4.1).

const TRACE_ID_HEADER = "x-trace-id";

/**
 * Generate a fresh trace id. We use UUID v4 today; the design calls
 * for v7 (time-sorted) which would also be valid here — the spec is
 * the SHAPE (36-char UUID) not the version, since the consumers
 * (Sentry/Langfuse) treat it as opaque.
 */
function generateTraceId(): string {
  return crypto.randomUUID();
}

/**
 * Validate an inbound trace id loosely — anything that LOOKS like a
 * 36-char UUID we trust; otherwise reject and generate a fresh one.
 * We don't want a misbehaving client wedging \r\n or 100KB of garbage
 * into our log lines.
 */
function isPlausibleTraceId(s: string | undefined): s is string {
  if (!s) return false;
  if (s.length !== 36) return false;
  return /^[0-9a-fA-F-]{36}$/.test(s);
}

/**
 * Assign or propagate a trace id for every request.
 *
 * Order in app.ts: traceId() → requestId() → requestLogger() so the
 * logger sees both ids when emitting its structured line.
 */
export async function traceId(c: Context<AppEnv>, next: Next) {
  const incoming = c.req.header(TRACE_ID_HEADER);
  const id = isPlausibleTraceId(incoming) ? incoming : generateTraceId();
  c.set("traceId", id);
  // Echo on response so the browser's devtools / our ApiError class
  // can pick it up without parsing the JSON envelope.
  c.header(TRACE_ID_HEADER, id);
  await next();
}

export { TRACE_ID_HEADER };
