import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Typed error hierarchy. Throw these from handlers; the onError mapper
// (see toErrorResponse) turns them into a unified envelope:
//   { error: { code, message, details? } }
// Unknown errors collapse to a 500 without leaking internals.

export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "UPSTREAM"
  | "RATE_LIMITED"
  | "INTERNAL";

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: ContentfulStatusCode;
  /** Optional machine-readable detail (e.g. Zod issues). */
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION" as const;
  readonly status = 400 as const;
}

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly status = 401 as const;
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly status = 403 as const;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly status = 404 as const;
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
  readonly status = 409 as const;
}

export class RateLimitedError extends AppError {
  readonly code = "RATE_LIMITED" as const;
  readonly status = 429 as const;
}

/** A failure originating from a downstream service (e.g. the Python agent). */
export class UpstreamError extends AppError {
  readonly code = "UPSTREAM" as const;
  readonly status = 502 as const;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/**
 * Map any thrown value to a typed error envelope + HTTP status.
 * Known AppErrors are surfaced verbatim; anything else becomes an opaque 500.
 */
export function toErrorResponse(err: unknown): {
  body: ErrorEnvelope;
  status: ContentfulStatusCode;
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
    };
  }

  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: "Internal server error" } },
  };
}

/** Hono onError handler: logs unexpected errors, returns the envelope. */
export function errorHandler(err: Error, c: Context): Response {
  const { body, status } = toErrorResponse(err);
  if (body.error.code === "INTERNAL") {
    // Only unexpected errors are noisy; expected AppErrors are part of control flow.
    console.error(
      `[API Error] ${c.req.method} ${c.req.url}: ${err.stack ?? err.message}`,
    );
  }
  return c.json(body, status);
}
