import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  test("applies defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.API_PORT).toBe(3001);
    expect(cfg.corsOrigins).toEqual(["http://localhost:3000"]);
  });

  test("coerces API_PORT and splits CORS_ORIGINS", () => {
    const cfg = loadConfig({
      API_PORT: "8080",
      CORS_ORIGINS: "http://a.com, http://b.com ,",
    });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.corsOrigins).toEqual(["http://a.com", "http://b.com"]);
  });

  test("rejects an invalid NODE_ENV", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  test("rejects a non-numeric API_PORT", () => {
    expect(() => loadConfig({ API_PORT: "not-a-number" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  test("rejects placeholder JWT secret in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", JWT_SECRET: "dev-secret-change-me" }),
    ).toThrow(/JWT_SECRET/);
  });

  test("accepts a real JWT secret in production", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "a-real-strong-secret",
    });
    expect(cfg.NODE_ENV).toBe("production");
  });
});
