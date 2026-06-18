import { describe, expect, test } from "bun:test";
import {
  CreateResumeSchema,
  UpdateResumeSchema,
  PrepareApplicationSchema,
  UpdateApplicationSchema,
  ApplicationStatusSchema,
  UpdateUserSchema,
  UserPreferencesSchema,
} from "./schemas";

describe("schemas", () => {
  test("CreateResumeSchema accepts content + optional isBase", () => {
    expect(CreateResumeSchema.safeParse({ content: { basics: {} } }).success).toBe(true);
    expect(
      CreateResumeSchema.safeParse({ content: { basics: {} }, isBase: false }).success,
    ).toBe(true);
  });

  test("CreateResumeSchema rejects missing/invalid content", () => {
    expect(CreateResumeSchema.safeParse({}).success).toBe(false);
    expect(CreateResumeSchema.safeParse({ content: "nope" }).success).toBe(false);
  });

  test("UpdateResumeSchema requires a non-negative integer expectedVersion", () => {
    expect(
      UpdateResumeSchema.safeParse({ content: {}, expectedVersion: 3 }).success,
    ).toBe(true);
    expect(
      UpdateResumeSchema.safeParse({ content: {}, expectedVersion: -1 }).success,
    ).toBe(false);
    expect(
      UpdateResumeSchema.safeParse({ content: {}, expectedVersion: 1.5 }).success,
    ).toBe(false);
    expect(UpdateResumeSchema.safeParse({ content: {} }).success).toBe(false);
  });

  test("PrepareApplicationSchema requires a uuid jobId", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(PrepareApplicationSchema.safeParse({ jobId: uuid }).success).toBe(true);
    expect(PrepareApplicationSchema.safeParse({ jobId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  test("UpdateApplicationSchema rejects an empty patch", () => {
    expect(UpdateApplicationSchema.safeParse({}).success).toBe(false);
    expect(UpdateApplicationSchema.safeParse({ status: "submitted" }).success).toBe(
      true,
    );
  });

  test("UpdateApplicationSchema rejects an unknown status", () => {
    expect(UpdateApplicationSchema.safeParse({ status: "ghosted" }).success).toBe(
      false,
    );
  });

  test("ApplicationStatusSchema enumerates the lifecycle states", () => {
    for (const s of [
      "draft",
      "review",
      "submitted",
      "interview",
      "rejected",
      "offer",
    ]) {
      expect(ApplicationStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  test("UserPreferencesSchema rejects unknown fields (strict)", () => {
    // Catches accidental camelCase/snake_case typos at the API boundary
    // instead of silently dropping them into the JSONB column.
    expect(
      UserPreferencesSchema.safeParse({ target_roles: ["swe"] }).success,
    ).toBe(false);
    expect(
      UserPreferencesSchema.safeParse({ targetRoles: ["swe"] }).success,
    ).toBe(true);
  });

  test("UserPreferencesSchema enforces per-field bounds", () => {
    expect(
      UserPreferencesSchema.safeParse({ minSalary: -1 }).success,
    ).toBe(false);
    expect(
      UserPreferencesSchema.safeParse({
        skills: new Array(51).fill("x"),
      }).success,
    ).toBe(false);
    expect(
      UserPreferencesSchema.safeParse({ remote: true, minSalary: 120000 })
        .success,
    ).toBe(true);
  });

  // Flywheel opt-in is an explicit boolean. Anything truthy-but-not-boolean
  // (legacy string from an older client, accidental `"true"`) must fail so a
  // user is never silently opted in by a serialisation glitch.
  test("UserPreferencesSchema accepts crowdsourceOptIn boolean and rejects strings", () => {
    expect(
      UserPreferencesSchema.safeParse({ crowdsourceOptIn: true }).success,
    ).toBe(true);
    expect(
      UserPreferencesSchema.safeParse({ crowdsourceOptIn: false }).success,
    ).toBe(true);
    expect(
      UserPreferencesSchema.safeParse({ crowdsourceOptIn: "true" }).success,
    ).toBe(false);
    expect(
      UserPreferencesSchema.safeParse({ crowdsourceOptIn: 1 }).success,
    ).toBe(false);
  });

  test("UpdateUserSchema rejects an empty patch", () => {
    expect(UpdateUserSchema.safeParse({}).success).toBe(false);
  });

  test("UpdateUserSchema accepts a single allowed field", () => {
    expect(UpdateUserSchema.safeParse({ displayName: "Alex" }).success).toBe(
      true,
    );
    expect(
      UpdateUserSchema.safeParse({
        preferences: { remote: true },
      }).success,
    ).toBe(true);
  });

  test("UpdateUserSchema rejects a malformed avatar URL", () => {
    expect(
      UpdateUserSchema.safeParse({ avatarUrl: "not-a-url" }).success,
    ).toBe(false);
  });
});
