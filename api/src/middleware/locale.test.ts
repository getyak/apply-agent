import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { locale } from "./locale";

// Wraps the locale middleware in a tiny app + one probe route. The probe
// route reads `c.get("locale")` and echoes it back as JSON so we can assert
// on both the context binding AND the X-Relay-Locale response header.
function makeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", locale);
  app.get("/probe", (c) => c.json({ locale: c.get("locale") }));
  return app;
}

describe("locale middleware", () => {
  test("X-Relay-Locale: zh wins over Accept-Language", async () => {
    const res = await makeApp().request("/probe", {
      headers: {
        "X-Relay-Locale": "zh",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    expect(res.headers.get("X-Relay-Locale")).toBe("zh");
    const body = (await res.json()) as { locale: string };
    expect(body.locale).toBe("zh");
  });

  test("Accept-Language: zh-CN resolves to zh when no explicit header", async () => {
    const res = await makeApp().request("/probe", {
      headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5" },
    });
    expect(res.headers.get("X-Relay-Locale")).toBe("zh");
  });

  test("falls back to en when nothing is set", async () => {
    const res = await makeApp().request("/probe");
    expect(res.headers.get("X-Relay-Locale")).toBe("en");
  });

  test("invalid X-Relay-Locale falls through to Accept-Language", async () => {
    const res = await makeApp().request("/probe", {
      headers: {
        "X-Relay-Locale": "klingon",
        "Accept-Language": "zh-TW",
      },
    });
    expect(res.headers.get("X-Relay-Locale")).toBe("zh");
  });

  test("response header echoes on error paths too (after route throws)", async () => {
    // Smoke for the contract: even when a downstream handler throws, the
    // header is set BEFORE next() so the client always sees the resolved
    // locale on the response.
    const app = new Hono<AppEnv>();
    app.use("*", locale);
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.onError((_err, c) => c.json({ ok: false }, 500));
    const res = await app.request("/boom", {
      headers: { "X-Relay-Locale": "zh" },
    });
    expect(res.headers.get("X-Relay-Locale")).toBe("zh");
  });
});
