import { describe, expect, it } from "bun:test";
import { unwrapForPublic } from "./routes/public-resumes";
import { unwrapResumeRow } from "./routes/resumes";

const parsed = {
  basics: {
    name: "Alex Doe",
    email: "alex@example.test",
  },
  work: [
    {
      name: "Acme",
      position: "Backend Engineer",
      startDate: "2022-01",
      endDate: "present",
      highlights: ["Migrated billing workloads to PostgreSQL."],
    },
  ],
};

const compiledEnvelope = {
  raw: "",
  parsed,
  artifactLocale: "zh" as const,
  compilerConfig: {
    profile_version: 1,
    artifact_locale: "zh",
    length_budget: "one_page",
    ats_profile: "strict",
  },
};

describe("Career Graph artifact locale", () => {
  it("pins private preview chrome to the compiler locale", () => {
    const row = unwrapResumeRow(
      { id: "resume-1", content: compiledEnvelope },
      "en",
    );
    const content = row.content as Record<string, unknown>;

    expect(content._markdown).toContain("## 工作经历");
    expect(content._markdown).not.toContain("## Experience");
    expect(content._artifactLocale).toBe("zh");
    expect(content._compilerConfig).toEqual(compiledEnvelope.compilerConfig);
  });

  it("pins public fallback rendering to the publishing artifact locale", () => {
    const result = unwrapForPublic(compiledEnvelope, "en");

    expect(result.markdown).toContain("## 工作经历");
    expect(result.markdown).not.toContain("## Experience");
    expect(result.artifactLocale).toBe("zh");
  });

  it("keeps request-locale fallback for legacy flat résumés", () => {
    const result = unwrapForPublic(parsed, "en");

    expect(result.markdown).toContain("## Experience");
    expect(result.artifactLocale).toBe("en");
  });

  it("falls back safely when stored locale metadata is malformed", () => {
    const result = unwrapForPublic(
      { ...compiledEnvelope, artifactLocale: "fr" },
      "en",
    );

    expect(result.markdown).toContain("## Experience");
    expect(result.artifactLocale).toBe("en");
  });
});
