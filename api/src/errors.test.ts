import { describe, expect, test } from "bun:test";
import {
  ConflictError,
  NotFoundError,
  UpstreamError,
  ValidationError,
  toErrorResponse,
} from "./errors";

describe("toErrorResponse", () => {
  test("maps ValidationError to 400 with details", () => {
    const { body, status } = toErrorResponse(
      new ValidationError("bad input", [{ field: "email" }]),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toBe("bad input");
    expect(body.error.details).toEqual([{ field: "email" }]);
  });

  test("maps NotFoundError to 404 without details key when none given", () => {
    const { body, status } = toErrorResponse(new NotFoundError("nope"));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect("details" in body.error).toBe(false);
  });

  test("maps ConflictError to 409", () => {
    expect(toErrorResponse(new ConflictError("dup")).status).toBe(409);
  });

  test("maps UpstreamError to 502", () => {
    expect(toErrorResponse(new UpstreamError("agent down")).status).toBe(502);
  });

  test("collapses unknown errors to opaque 500", () => {
    const { body, status } = toErrorResponse(new Error("secret internal detail"));
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Internal server error");
  });

  test("collapses non-Error throws to 500", () => {
    expect(toErrorResponse("just a string").status).toBe(500);
  });
});
