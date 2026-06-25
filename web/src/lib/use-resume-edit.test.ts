// Pure-function tests for the helpers behind useResumeEdit. We don't drive
// the hook itself here — that requires React + happy-dom which the rest of
// the web package deliberately avoids (see use-elapsed.test.ts for the
// "test the formatter, not the hook" pattern). The helpers we test here are
// what determines whether inline editing produces the right JsonResume shape.
//
// Cover the branches that can corrupt the document if wrong:
//
//   1. setAtPath on a nested array path mutates only the right index.
//      A bullet-edit would become a full-list rewrite if this is off.
//
//   2. setAtPath on a missing intermediate creates the right *container*
//      (array vs object) based on the next segment. "Add bullet" relies on
//      this — when a role has no `highlights` yet, commit("work.0.highlights.0",
//      text) has to create an array, not an object with key "0".
//
//   3. stripEnvelope drops `_*` fields. Without this, autosave PUTs would
//      ship `_markdown` etc. back to the server, which the envelope rebuild
//      then re-derives — wasted bandwidth and a corrupted round-trip if the
//      server ever validates schema strictly.

import { describe, expect, it } from "bun:test";
import { __test } from "./use-resume-edit";

const { getAtPath, setAtPath, stripEnvelope } = __test;

describe("setAtPath", () => {
  it("updates a deep array entry without touching siblings", () => {
    const doc = {
      work: [
        { name: "Acme", highlights: ["a", "b", "c"] },
        { name: "Beta", highlights: ["x"] },
      ],
    };
    const next = setAtPath(doc, "work.0.highlights.1", "B!");
    expect(next).toEqual({
      work: [
        { name: "Acme", highlights: ["a", "B!", "c"] },
        { name: "Beta", highlights: ["x"] },
      ],
    });
    // Reference-equality on untouched branches: setAtPath is pure and the
    // editor relies on this so unaffected sections don't re-render.
    expect((next as typeof doc).work[1]).toBe(doc.work[1]);
    expect(doc.work[0].highlights[1]).toBe("b"); // original unchanged
  });

  it("creates an array container when the next segment is numeric", () => {
    const doc = { work: [{ name: "Acme" }] } as Record<string, unknown>;
    const next = setAtPath(doc, "work.0.highlights.0", "first") as {
      work: Array<{ highlights: unknown }>;
    };
    expect(Array.isArray(next.work[0]!.highlights)).toBe(true);
    expect(next.work[0]!.highlights).toEqual(["first"]);
  });

  it("creates an object container when the next segment is not numeric", () => {
    const next = setAtPath({}, "basics.location.city", "Beijing") as {
      basics: { location: { city: string } };
    };
    expect(next).toEqual({ basics: { location: { city: "Beijing" } } });
  });

  it("can overwrite a whole subtree (used by 'Add role')", () => {
    const doc = { work: [] as unknown[] };
    const role = { name: "New Co", highlights: [""] };
    const next = setAtPath(doc, "work.0", role) as { work: unknown[] };
    expect(next.work[0]).toEqual(role);
  });
});

describe("getAtPath", () => {
  it("returns undefined on a missing path without throwing", () => {
    expect(getAtPath({}, "work.0.highlights.2")).toBeUndefined();
  });

  it("traverses arrays by numeric segment", () => {
    expect(getAtPath({ work: [{ name: "Acme" }] }, "work.0.name")).toBe("Acme");
  });
});

describe("stripEnvelope", () => {
  it("drops underscore-prefixed fields and keeps the rest", () => {
    const stripped = stripEnvelope({
      basics: { name: "X" },
      work: [],
      _markdown: "# H",
      _raw: "raw text",
      _warnings: ["w1"],
      _source: { fileId: "u" },
    });
    expect(stripped).toEqual({ basics: { name: "X" }, work: [] });
  });
});
