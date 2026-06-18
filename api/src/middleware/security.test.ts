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

  // The dev-loopback escape hatch: any 127.0.0.1 / localhost / [::1] port is
  // admitted in NODE_ENV !== "production" so a prod build smoke on 3010 or a
  // Playwright run binding a fresh port doesn't get blocked by a default
  // allowlist of localhost:3000. NODE_ENV is "test" while bun test runs, so
  // these assertions exercise the same branch dev does.
  test("allows 127.0.0.1 on any port in dev/test", () => {
    expect(resolveCorsOrigin("http://127.0.0.1:3010")).toBe("http://127.0.0.1:3010");
    expect(resolveCorsOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(resolveCorsOrigin("http://127.0.0.1")).toBe("http://127.0.0.1");
  });

  test("allows localhost on any port in dev/test", () => {
    expect(resolveCorsOrigin("http://localhost:3010")).toBe("http://localhost:3010");
    expect(resolveCorsOrigin("http://localhost:8080")).toBe("http://localhost:8080");
  });

  test("allows IPv6 loopback in dev/test", () => {
    expect(resolveCorsOrigin("http://[::1]:3010")).toBe("http://[::1]:3010");
  });

  test("still denies non-loopback even when port pattern matches", () => {
    expect(resolveCorsOrigin("http://10.0.0.5:3010")).toBeNull();
    expect(resolveCorsOrigin("http://attacker.com:3000")).toBeNull();
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
