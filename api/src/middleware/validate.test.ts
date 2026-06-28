import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { validateBody, validateQuery, flattenIssues } from "./validate";
import { errorHandler } from "../errors";
import type { AppEnv } from "../types";

const BodySchema = z.object({ name: z.string().min(1) });

function appWithBody() {
  const app = new Hono<AppEnv>();
  app.post("/", validateBody(BodySchema), (c) =>
    c.json({ got: c.get("validatedBody") }),
  );
  app.onError(errorHandler);
  return app;
}

describe("validate middleware", () => {
  test("passes a valid body through and stores the parsed value", async () => {
    const res = await appWithBody().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { name: "Ada" } });
  });

  test("rejects an invalid body with a 400 VALIDATION envelope", async () => {
    const res = await appWithBody().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; details: unknown } };
    expect(json.error.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(json.error.details)).toBe(true);
  });

  test("rejects malformed JSON as a 400 (not a 500)", async () => {
    const res = await appWithBody().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  test("validateQuery coerces and validates query params", async () => {
    const app = new Hono<AppEnv>();
    app.get(
      "/",
      validateQuery(z.object({ page: z.coerce.number().int() })),
      (c) => c.json(c.get("validatedQuery")),
    );
    app.onError(errorHandler);
    const res = await app.request("/?page=4");
    expect(await res.json()).toEqual({ page: 4 });
  });

  test("flattenIssues produces compact path/message pairs", () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });
    if (parsed.success) throw new Error("expected failure");
    const issues = flattenIssues(parsed.error);
    expect(issues[0].path).toBe("a");
    expect(typeof issues[0].message).toBe("string");
  });
});
