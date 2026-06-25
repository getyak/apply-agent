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

  it("saveBaseResume re-upload demotes the prior base without touching content/version", () => {
    // Migration 017 made originals immutable, so re-upload no longer UPDATEs
    // content in place — it demotes the old base (is_base = false) then INSERTs
    // a new track='original' row. The demotion UPDATE must touch ONLY the
    // is_base flag: no content (the immutability trigger would reject it) and
    // no version bump (that was the second 23505 path pre-016).
    const updateBlock = SRC.match(
      /UPDATE resumes SET is_base = false\s*WHERE user_id = \$1 AND is_base = true/,
    );
    expect(updateBlock, "saveBaseResume demotion UPDATE not found").not.toBeNull();
    expect(updateBlock![0]).not.toMatch(/version\s*=/);
    expect(updateBlock![0]).not.toMatch(/content\s*=/);
    expect(updateBlock![0]).not.toMatch(/MAX\(version\)/);
  });

  it("saveBaseResume re-upload INSERTs a fresh track='original' row", () => {
    // The new original is INSERTed with version=0 (trigger assigns) and an
    // explicit track='original' so it isn't silently classed as 'optimized'
    // by the column default.
    const insertBlock = SRC.match(
      /INSERT INTO resumes \(user_id, content, version, is_base, track, source_file_id, created_at\)\s*VALUES \([^)]+\)/,
    );
    expect(insertBlock, "saveBaseResume original INSERT not found").not.toBeNull();
    expect(insertBlock![0]).toContain(", 0,");
    expect(insertBlock![0]).toContain("'original'");
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

// Static guard for the edit/save R-1 contract.
//
// Autosave uses ?mode=draft to overwrite content at the same row version
// (no timeline bump per keystroke). The snapshot path bumps version — that's
// the user-visible "Save" action. Both keep the optimistic-lock guard so a
// concurrent writer surfaces as 409 for the §5 reconcile UX.
describe("resumes.ts — edit/save draft-vs-snapshot guards", () => {
  it("draft mode UPDATE keeps version unchanged", () => {
    const draftSql = SRC.match(
      /UPDATE resumes SET content = \$1\s*WHERE id = \$2 AND user_id = \$3 AND version = \$4/,
    );
    expect(draftSql, "draft-mode UPDATE not found").not.toBeNull();
    expect(draftSql![0]).not.toMatch(/version\s*=\s*version\s*\+\s*1/);
  });

  it("snapshot mode UPDATE bumps version", () => {
    const snapshotSql = SRC.match(
      /UPDATE resumes SET content = \$1, version = version \+ 1\s*WHERE id = \$2 AND user_id = \$3 AND version = \$4/,
    );
    expect(snapshotSql, "snapshot-mode UPDATE not found").not.toBeNull();
  });

  it("mode is gated on the literal string 'draft'", () => {
    // Anything looser (truthy check, includes-match) would let `?mode=anything`
    // silently skip the version bump. The route is defensive — unknown values
    // fall back to snapshot.
    expect(SRC).toMatch(/c\.req\.query\("mode"\)\s*===\s*"draft"/);
  });

  it("response echoes mode so the client status chip can branch", () => {
    // Without this, the client has to compare version numbers to know whether
    // a save bumped — which is racy across tabs (§5).
    expect(SRC).toMatch(/resume:\s*unwrapResumeRow[^,]+,\s*mode/);
  });
});
