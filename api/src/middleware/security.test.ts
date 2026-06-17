import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  resolveCorsOrigin,
  securityHeaders,
  bodySizeLimit,
  MAX_BODY_BYTES,
} from "./security";

describe("resolveCorsOrigin", () => {
  test("allows the configured web origin (default localhost:3000)", () => {
    expect(resolveCorsOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  test("allows any chrome-extension:// origin", () => {
    const ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    expect(resolveCorsOrigin(ext)).toBe(ext);
  });

  test("denies an arbitrary cross-site origin", () => {
    expect(resolveCorsOrigin("https://evil.example.com")).toBeNull();
  });

  test("denies an empty origin", () => {
    expect(resolveCorsOrigin("")).toBeNull();
  });
});

describe("securityHeaders middleware", () => {
  test("sets nosniff and frame-deny headers", async () => {
    const app = new Hono();
    app.use("*", securityHeaders);
    app.get("/", (c) => c.json({ ok: true }));
    const res = await app.request("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("bodySizeLimit middleware", () => {
  test("rejects an oversized body with 413", async () => {
    const app = new Hono();
    app.use("*", bodySizeLimit);
    app.post("/", async (c) => c.json(await c.req.json()));
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ big }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("VALIDATION");
  });

  test("allows a small body through", async () => {
    const app = new Hono();
    app.use("*", bodySizeLimit);
    app.post("/", async (c) => c.json(await c.req.json()));
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(res.status).toBe(200);
  });
});
