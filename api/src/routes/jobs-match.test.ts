import { describe, expect, it } from "bun:test";
import { lexicalMatch, normalizeBreakdown } from "./jobs";

describe("job match evidence", () => {
  it("preserves an explicit zero instead of turning it into neutral", () => {
    expect(
      normalizeBreakdown({
        skills: 0,
        level: 1,
        location: -1,
        salary: 2,
      }),
    ).toEqual({ skills: 0, level: 1, location: 0, salary: 1 });
  });

  it("uses the parsed résumé envelope and reports explicit missing skills", () => {
    const match = lexicalMatch(
      { skills: ["TypeScript", "PostgreSQL", "Kafka"] },
      {
        parsed: {
          basics: { label: "Senior Backend Engineer" },
          work: [{ position: "Senior Software Engineer" }],
          skills: [{ name: "TypeScript" }, { name: "Postgres" }],
        },
      },
      "",
      "Senior Backend Engineer",
    );

    expect(match.aiGenerated).toBe(false);
    expect(match.matchedSkills).toEqual(["TypeScript", "PostgreSQL"]);
    expect(match.missingSkills).toEqual(["Kafka"]);
    expect(match.breakdown.level).toBe(1);
  });

  it("does not infer a résumé skill when the raw JD never mentions it", () => {
    const match = lexicalMatch(
      {},
      {
        basics: { label: "Backend Engineer" },
        work: [{ position: "Backend Engineer" }],
        skills: [{ name: "Rust" }, { name: "Go" }],
      },
      "Build reliable services with Go and PostgreSQL.",
      "Backend Engineer",
    );

    expect(match.matchedSkills).toEqual(["Go"]);
    expect(match.missingSkills).toEqual([]);
  });

  it("keeps seniority unknown neutral and penalizes an evidenced large gap", () => {
    const unknown = lexicalMatch(
      { skills: [] },
      { basics: { label: "Backend Engineer" }, skills: [] },
      "",
      "Senior Backend Engineer",
    );
    const gap = lexicalMatch(
      { skills: [] },
      { basics: { label: "Junior Backend Engineer" }, skills: [] },
      "",
      "Staff Backend Engineer",
    );

    expect(unknown.breakdown.level).toBe(0.5);
    expect(gap.breakdown.level).toBe(0.35);
  });
});
