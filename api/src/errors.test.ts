import { describe, expect, test } from "bun:test";
import {
  AppError,
  AuthInvalidCredentialsError,
  ConflictError,
  DbUnavailableError,
  Errors,
  NotFoundError,
  UpstreamError,
  ValidationError,
  errorHandler,
  toErrorResponse,
  traceCodeFromTraceId,
  translateInfraError,
} from "./errors";

// envelope v2 contract (docs/architecture/error-handling.md §2.1)
describe("toErrorResponse", () => {
  test("maps ValidationError to 400 with all envelope v2 fields", () => {
    const { body, status } = toErrorResponse(
      Errors.validation("bad input", [{ field: "email" }], [
        { name: "email", msg: "Invalid" },
      ]),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toBe("bad input");
    expect(body.error.details).toEqual([{ field: "email" }]);
    expect(body.error.messageKey).toBe("errors.validation.failed");
    expect(body.error.action).toEqual({
      kind: "fix-input",
      fields: [{ name: "email", msg: "Invalid" }],
    });
    // every envelope must carry trace + timestamp
    expect(typeof body.error.traceId).toBe("string");
    expect(body.error.traceId.length).toBe(36);
    expect(body.error.traceCode).toMatch(/^R-[0-9A-Z]{4}$/);
    expect(typeof body.error.timestamp).toBe("string");
    expect(new Date(body.error.timestamp).toISOString()).toBe(
      body.error.timestamp,
    );
  });

  test("legacy 2-arg constructor still maps to envelope v2", () => {
    // Pre-v2 sites do `new ValidationError("msg", { field: "x" })`.
    const { body, status } = toErrorResponse(
      new ValidationError("legacy form", [{ field: "x" }]),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toEqual([{ field: "x" }]);
    // Round-20: legacy throws now inherit code-keyed defaults from
    // DEFAULT_ENVELOPE_BY_CODE so every envelope satisfies error-handling.md
    // §4 (P4) even without migrating to the Errors.* factories.
    expect(body.error.messageKey).toBe("errors.validation.failed");
    expect(body.error.action).toEqual({ kind: "none" });
  });

  test("maps NotFoundError to 404 without details key when none given", () => {
    const { body, status } = toErrorResponse(new NotFoundError("nope"));
    expect(status).toBe(404);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect("details" in body.error).toBe(false);
  });

  test("maps ConflictError to 409", () => {
    const { status, body } = toErrorResponse(new ConflictError("dup"));
    expect(status).toBe(409);
    expect(body.error.code).toBe("RESOURCE_CONFLICT");
  });

  test("maps UpstreamError to 502", () => {
    const { status, body } = toErrorResponse(new UpstreamError("agent down"));
    expect(status).toBe(502);
    expect(body.error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  test("Errors.invalidCreds carries messageKey + no-CTA action", () => {
    const { body, status } = toErrorResponse(Errors.invalidCreds());
    expect(status).toBe(401);
    expect(body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(body.error.messageKey).toBe("errors.auth.invalidCredentials");
    expect(body.error.action).toEqual({ kind: "none" });
  });

  test("Errors.sessionExpired carries reauth action + redirect", () => {
    const { body, status } = toErrorResponse(Errors.sessionExpired());
    expect(status).toBe(401);
    expect(body.error.code).toBe("AUTH_SESSION_EXPIRED");
    expect(body.error.action).toMatchObject({
      kind: "reauth",
      redirect: expect.stringMatching(/^\/auth/),
    });
  });

  test("Errors.rateLimited preserves retryAfterSeconds in details + action", () => {
    const { body, status } = toErrorResponse(
      Errors.rateLimited({ scope: "auth", retryAfterSeconds: 7 }),
    );
    expect(status).toBe(429);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect((body.error.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(7);
    expect(body.error.action).toEqual({ kind: "retry", after: 7 });
  });

  test("collapses unknown errors to opaque INTERNAL 500", () => {
    const { body, status } = toErrorResponse(new Error("secret internal detail"));
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Internal server error");
    // No raw cause leak to the user-facing message — must not contain the
    // original "secret internal detail" string.
    expect(body.error.message.includes("secret internal detail")).toBe(false);
  });

  test("collapses non-Error throws to INTERNAL 500", () => {
    const { status, body } = toErrorResponse("just a string");
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
  });

  test("passes traceId + requestId through opts", () => {
    const tid = "01935f4e-7e1e-7d72-a9a0-6cf0a0123456";
    const rid = "req-1";
    const { body } = toErrorResponse(Errors.invalidCreds(), {
      traceId: tid,
      requestId: rid,
    });
    expect(body.error.traceId).toBe(tid);
    expect(body.error.requestId).toBe(rid);
    // Same traceId → same traceCode (deterministic).
    expect(body.error.traceCode).toBe(traceCodeFromTraceId(tid));
  });
});

// translateInfraError contract (docs §4.1.3)
describe("translateInfraError", () => {
  test("PG pool death → DB_UNAVAILABLE", () => {
    const e = translateInfraError(
      new Error("Cannot use a pool after calling end on the pool"),
    );
    expect(e).toBeInstanceOf(DbUnavailableError);
    expect(e!.code).toBe("DB_UNAVAILABLE");
    expect(e!.status).toBe(503);
    expect(e!.action).toEqual({ kind: "retry", after: 5 });
    expect(e!.messageKey).toBe("errors.system.dbUnavailable");
  });

  test("PG connection terminated → DB_UNAVAILABLE", () => {
    const e = translateInfraError(
      new Error("Connection terminated unexpectedly"),
    );
    expect(e?.code).toBe("DB_UNAVAILABLE");
  });

  test("PG ECONNREFUSED on the 5433 port → DB_UNAVAILABLE", () => {
    const e = translateInfraError(
      new Error("ECONNREFUSED 127.0.0.1:5433 (postgres)"),
    );
    expect(e?.code).toBe("DB_UNAVAILABLE");
  });

  test("Redis Connection is closed → CACHE_UNAVAILABLE", () => {
    const err = new Error("Connection is closed.");
    err.name = "RedisError";
    const e = translateInfraError(err);
    expect(e?.code).toBe("CACHE_UNAVAILABLE");
  });

  test("Generic TimeoutError → UPSTREAM_TIMEOUT", () => {
    const err = new Error("Operation timed out");
    err.name = "TimeoutError";
    const e = translateInfraError(err);
    expect(e?.code).toBe("UPSTREAM_TIMEOUT");
  });

  test("ETIMEDOUT in message → UPSTREAM_TIMEOUT", () => {
    const e = translateInfraError(new Error("connect ETIMEDOUT 1.2.3.4:8000"));
    expect(e?.code).toBe("UPSTREAM_TIMEOUT");
  });

  test("Unrecognized error → null (caller falls back to INTERNAL)", () => {
    expect(translateInfraError(new Error("random unrelated failure"))).toBeNull();
    expect(translateInfraError("string")).toBeNull();
    expect(translateInfraError(undefined)).toBeNull();
  });

  test("End-to-end via toErrorResponse: unknown pool error → DB_UNAVAILABLE", () => {
    // This is the exact path that exposed the 2026-06-28 production
    // incident in the UI as 'Internal server error'. Post-fix, the
    // gateway must instead surface a typed DB_UNAVAILABLE envelope
    // that the web layer renders as a 'brief hiccup' card.
    const { body, status } = toErrorResponse(
      new Error("Cannot use a pool after calling end on the pool"),
    );
    expect(status).toBe(503);
    expect(body.error.code).toBe("DB_UNAVAILABLE");
    expect(body.error.message).toBe("Database temporarily unavailable");
  });
});

// traceCodeFromTraceId contract (docs §2.2)
describe("traceCodeFromTraceId", () => {
  test("emits 'R-XXXX' for any UUID-looking input", () => {
    const code = traceCodeFromTraceId("01935f4e-7e1e-7d72-a9a0-6cf0a0123456");
    expect(code).toMatch(/^R-[0-9A-Z]{4}$/);
  });

  test("deterministic: same traceId → same traceCode", () => {
    const t = "01935f4e-7e1e-7d72-a9a0-6cf0a0123456";
    expect(traceCodeFromTraceId(t)).toBe(traceCodeFromTraceId(t));
  });

  test("falls back to R-0000 for too-short inputs", () => {
    expect(traceCodeFromTraceId("short")).toBe("R-0000");
  });
});

// errorHandler middleware contract — covers the headers wiring the
// design promises (X-Trace-Id always, X-Request-Id when set,
// X-Relay-Health=degraded for infra failures).
describe("errorHandler", () => {
  function makeCtx({
    traceId,
    requestId,
  }: {
    traceId?: string;
    requestId?: string;
  } = {}) {
    const headers: Record<string, string> = {};
    const vars: Record<string, string | undefined> = {
      traceId,
      requestId,
    };
    const ctx = {
      req: { method: "POST", url: "http://test/api/auth/login" },
      // hono's c.get
      get: (k: string) => vars[k],
      header: (k: string, v: string) => {
        headers[k] = v;
      },
      json: (body: unknown, status: number) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
    };
    return { ctx: ctx as unknown as Parameters<typeof errorHandler>[1], headers };
  }

  test("emits X-Trace-Id always; X-Request-Id when present", () => {
    const { ctx, headers } = makeCtx({
      traceId: "01935f4e-7e1e-7d72-a9a0-6cf0a0123456",
      requestId: "req-abc",
    });
    const res = errorHandler(new AuthInvalidCredentialsError("bad"), ctx);
    expect(res.status).toBe(401);
    expect(headers["X-Trace-Id"]).toBe(
      "01935f4e-7e1e-7d72-a9a0-6cf0a0123456",
    );
    expect(headers["X-Request-Id"]).toBe("req-abc");
    // not degraded for 4xx control-flow errors
    expect(headers["X-Relay-Health"]).toBeUndefined();
  });

  test("emits X-Relay-Health=degraded for DB_UNAVAILABLE", () => {
    const { ctx, headers } = makeCtx({});
    errorHandler(
      new Error("Cannot use a pool after calling end on the pool") as Error,
      ctx,
    );
    expect(headers["X-Relay-Health"]).toBe("degraded");
    expect(headers["X-Trace-Id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("emits X-Relay-Health=degraded for LLM_UNAVAILABLE", () => {
    const { ctx, headers } = makeCtx({});
    errorHandler(Errors.llmUnavailable() as unknown as Error, ctx);
    expect(headers["X-Relay-Health"]).toBe("degraded");
  });
});

// type-system sanity: AppError instances expose code/status/messageKey
describe("AppError shape", () => {
  test("Errors.invalidCreds is an AppError instance with the right code", () => {
    const e = Errors.invalidCreds();
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(e.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Round-20 regression: direct AppError subclass constructions (e.g.
// `throw new UpstreamError("Resume optimization failed", err.message)`
// in routes/resumes.ts) used to ship envelopes with no messageKey / no
// action. error-handling.md §4 (P4) requires every emitted envelope to
// carry both so the web error-router can render a real CTA. The
// DEFAULT_ENVELOPE_BY_CODE fallback closes that gap.
// ─────────────────────────────────────────────────────────────────────────

// UpstreamError is already in the module-level import above; pull in just
// the additional subclasses needed for these regression tests.
import { LlmUnavailableError, UpstreamTimeoutError } from "./errors";

describe("round-20 envelope defaults by code", () => {
  test("UpstreamError direct ctor gets default action + messageKey", () => {
    const { body, status } = toErrorResponse(
      new UpstreamError("agent down", "raw cause"),
    );
    expect(status).toBe(502);
    expect(body.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(body.error.messageKey).toBe("errors.upstream.unavailable");
    expect(body.error.action).toEqual({ kind: "retry", after: 5 });
    expect(body.error.details).toBe("raw cause");
  });

  test("UpstreamTimeoutError direct ctor gets default retry action", () => {
    const { body, status } = toErrorResponse(
      new UpstreamTimeoutError("slow"),
    );
    expect(status).toBe(504);
    expect(body.error.messageKey).toBe("errors.upstream.timeout");
    expect(body.error.action).toEqual({ kind: "retry", after: 5 });
  });

  test("LlmUnavailableError direct ctor gets retry-after-10 default", () => {
    const { body, status } = toErrorResponse(
      new LlmUnavailableError("dead"),
    );
    expect(status).toBe(503);
    expect(body.error.messageKey).toBe("errors.llm.unavailable");
    expect(body.error.action).toEqual({ kind: "retry", after: 10 });
  });

  test("explicit messageKey/action override the defaults", () => {
    const { body } = toErrorResponse(
      new UpstreamError("agent down", {
        messageKey: "errors.custom.special",
        action: { kind: "none" },
      }),
    );
    expect(body.error.messageKey).toBe("errors.custom.special");
    expect(body.error.action).toEqual({ kind: "none" });
  });
});
