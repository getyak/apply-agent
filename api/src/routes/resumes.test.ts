// Regression guard for the onboarding 23505 fix (migration 016).
//
// Three statics we never want to drift back into the file:
//
// 1. POST / and saveBaseResume must INSERT resumes with version=0 (or NULL)
//    so the BEFORE INSERT trigger assigns the next per-user version under
//    a per-user advisory lock. If anyone re-introduces an app-level
//    SELECT MAX(version)+1 ahead of an INSERT, the test fails and points
//    at the line.
//
// 2. saveBaseResume's UPDATE branch (re-upload) must NOT touch the version
//    column. Re-parsing the same base PDF is a refresh of v1, not a new
//    version. Setting version = MAX(...)+1 here was the second 23505 path.
//
// 3. The PG_UNIQUE_VIOLATION retry constant is gone. We don't need an
//    application-level race-recovery loop anymore — the trigger handles it.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "resumes.ts"), "utf8");

describe("resumes.ts — migration 016 regression guards", () => {
  it("POST / INSERTs with version=0 (trigger assigns)", () => {
    // The first INSERT in the file is POST /.
    const firstInsert = SRC.match(
      /INSERT INTO resumes \(user_id, content, version, is_base, created_at\)\s*VALUES \([^)]+\)/,
    );
    expect(firstInsert, "first INSERT not found — file shape changed").not.toBeNull();
    // Expect a literal 0 in the VALUES list, not $3 (which would mean a
    // bound parameter, i.e. app-computed version).
    expect(firstInsert![0]).toContain(", 0,");
  });

  it("saveBaseResume re-upload UPDATE does NOT bump version", () => {
    // Pull the UPDATE statement inside saveBaseResume.
    const updateBlock = SRC.match(
      /UPDATE resumes[\s\S]+?WHERE user_id = \$2 AND is_base = true/,
    );
    expect(updateBlock, "saveBaseResume UPDATE not found").not.toBeNull();
    // Must not SET version.
    expect(updateBlock![0]).not.toMatch(/SET[\s\S]*version\s*=/);
    // And must not subquery MAX(version) anywhere in the UPDATE.
    expect(updateBlock![0]).not.toMatch(/MAX\(version\)/);
  });

  it("application-level MAX(version)+1 is gone", () => {
    // Pre-016, both POST / and saveBaseResume read MAX(version)+1 before
    // INSERTing. The trigger replaces both. Any new occurrence is a
    // regression — fail loudly.
    expect(SRC).not.toMatch(/COALESCE\(MAX\(version\),\s*0\)\s*\+\s*1/);
  });

  it("23505 retry loop is removed", () => {
    // The old saveBaseResume wrapped its work in a 3-attempt try/catch on
    // PG_UNIQUE_VIOLATION. With the trigger in place that loop is dead
    // weight — and it hid the real problem when it fired. Make sure no
    // one re-adds it without thinking.
    expect(SRC).not.toContain("PG_UNIQUE_VIOLATION");
    expect(SRC).not.toMatch(/const\s+ATTEMPTS\s*=/);
  });
});
