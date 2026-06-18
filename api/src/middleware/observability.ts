import type { Context, Next } from "hono";
import type { AppEnv } from "../types";

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Assigns a correlation id to every request (reusing an inbound x-request-id
 * when present), exposes it on the context (`c.get("requestId")`) and echoes it
 * back in the response header. Pair with requestLogger for traceable logs.
 */
export async function requestId(c: Context<AppEnv>, next: Next) {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  const id = incoming && incoming.length <= 200 ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  c.header(REQUEST_ID_HEADER, id);
  await next();
}

/**
 * Emits one structured JSON log line per request with method, path, status,
 * latency, request id and (when authenticated) user id. Runs the handler first
 * so the final status is known; never swallows downstream errors.
 */
export async function requestLogger(c: Context<AppEnv>, next: Next) {
  const start = performance.now();
  try {
    await next();
  } finally {
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;
    const line = {
      level: "info",
      msg: "request",
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      latencyMs,
      requestId: c.get("requestId"),
      // userId is only set after authMiddleware; undefined on public routes.
      userId: c.get("userId"),
    };
    console.log(JSON.stringify(line));
  }
}

export { REQUEST_ID_HEADER };
