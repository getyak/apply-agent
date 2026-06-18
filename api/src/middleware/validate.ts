import type { Context, Next } from "hono";
import { z } from "zod";
import { ValidationError } from "../errors";

// Centralized request validation. Routes read raw `c.req.json()` / query params
// today; this middleware parses-and-stores a typed value once, so handlers can
// pull `c.get("validatedBody")` instead of re-reading + casting. A failed parse
// throws ValidationError (→ unified 400 envelope with Zod issues as details),
// never a raw Hono 400, so error shape stays consistent across the API.

/** Where the validated value is stashed on the context. */
type Target = "body" | "query" | "param";

const CTX_KEY: Record<Target, string> = {
  body: "validatedBody",
  query: "validatedQuery",
  param: "validatedParam",
};

/**
 * Build a validation middleware for one request part.
 *
 *   app.post("/", validate("body", CreateResumeSchema), (c) => {
 *     const input = c.get("validatedBody"); // typed
 *   })
 *
 * Query params arrive as strings; schemas should use `z.coerce.*` where a
 * non-string type is wanted. JSON body parse failures are themselves treated
 * as a validation error (malformed JSON → 400, not 500).
 */
export function validate<S extends z.ZodTypeAny>(target: Target, schema: S) {
  return async (c: Context, next: Next) => {
    let raw: unknown;
    if (target === "body") {
      raw = await c.req.json().catch(() => {
        throw new ValidationError("Request body must be valid JSON");
      });
    } else if (target === "query") {
      raw = c.req.query(); // Record<string, string>
    } else {
      raw = c.req.param();
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Request validation failed", flattenIssues(parsed.error));
    }
    c.set(CTX_KEY[target], parsed.data);
    await next();
  };
}

/** Convenience wrappers. */
export const validateBody = <S extends z.ZodTypeAny>(schema: S) =>
  validate("body", schema);
export const validateQuery = <S extends z.ZodTypeAny>(schema: S) =>
  validate("query", schema);

/** Reduce a ZodError to a compact, client-safe `{ path, message }[]`. */
export function flattenIssues(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}
