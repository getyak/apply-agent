import type { Context } from "hono";
import { config } from "./config";
import type { AppEnv } from "./types";

// Helper for proxying to the FastAPI agent host (agents/api/server.py).
// Centralises the trace + correlation header forwarding so every fetch
// site automatically inherits the same plumbing — see
// docs/architecture/error-handling.md §5.
//
// In particular:
//   - X-Trace-Id is forwarded so the gateway's trace id is the SAME id
//     that lands in the Python structlog binding + LangGraph state +
//     Langfuse span; one id, three layers (W4.1 + W4.2).
//   - X-Request-Id is forwarded so per-HTTP correlation is preserved.
//   - X-Relay-User-Id is the trust-boundary handoff: the gateway has
//     already verified the JWT in requireAuth, so we pass the user
//     id explicitly and the FastAPI side doesn't re-verify (it doesn't
//     even have the JWT secret).
//
// Extra headers can be merged in for endpoints that need them
// (X-Relay-Thread-Id, X-Relay-Surface, X-Relay-Locale, etc.). Caller-
// provided values for the standard correlation headers always win —
// this helper does NOT clobber whatever the caller explicitly set.

export interface AgentFetchOptions extends Omit<RequestInit, "headers"> {
  /** The Hono context — used to read traceId / requestId / userId. */
  ctx: Context<AppEnv>;
  /** Path on the agent host, e.g. "/ask/stream" or "/resume/optimize". */
  path: string;
  /** Extra headers to merge on top of the standard set. */
  headers?: Record<string, string>;
  /** If true, the JSON Content-Type header is added automatically. */
  json?: boolean;
}

export async function agentFetch(opts: AgentFetchOptions): Promise<Response> {
  const { ctx, path, headers: extraHeaders = {}, json = true, ...init } = opts;

  const userId = ctx.get("userId") as string | undefined;
  const traceId = ctx.get("traceId") as string | undefined;
  const requestId = ctx.get("requestId") as string | undefined;

  const baseHeaders: Record<string, string> = {};
  if (json) baseHeaders["Content-Type"] = "application/json";
  if (userId) baseHeaders["X-Relay-User-Id"] = userId;
  if (traceId) baseHeaders["X-Trace-Id"] = traceId;
  if (requestId) baseHeaders["X-Request-Id"] = requestId;

  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}${path}`;

  return fetch(target, {
    ...init,
    headers: {
      ...baseHeaders,
      // Caller-supplied headers win — they may want to override e.g.
      // Content-Type for streaming endpoints, or pin a specific
      // X-Relay-Thread-Id.
      ...extraHeaders,
    },
  });
}

/**
 * For the rare site that doesn't have a Hono context (cron / event
 * consumer): same shape but takes the ids directly. Prefer agentFetch()
 * everywhere a context is available.
 */
export async function agentFetchExplicit(
  path: string,
  init: RequestInit & {
    userId?: string;
    traceId?: string;
    requestId?: string;
  },
): Promise<Response> {
  const { userId, traceId, requestId, headers, ...rest } = init;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (userId) baseHeaders["X-Relay-User-Id"] = userId;
  if (traceId) baseHeaders["X-Trace-Id"] = traceId;
  if (requestId) baseHeaders["X-Request-Id"] = requestId;
  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}${path}`;
  return fetch(target, {
    ...rest,
    headers: { ...baseHeaders, ...(headers as Record<string, string>) },
  });
}
