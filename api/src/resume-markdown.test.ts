import { describe, it, expect } from "bun:test";
import { jsonResumeToMarkdown } from "./resume-markdown";
import type { JsonResume } from "./resume-parse";

describe("jsonResumeToMarkdown", () => {
  it("renders a full résumé into canonical GFM", () => {
    const resume: JsonResume = {
      basics: {
        name: "Xiong Xinwei",
        label: "Senior Backend Engineer",
        email: "x@example.com",
        phone: "+86 138 0000 0000",
        summary: "Backend engineer focused on payments infra.",
        location: { city: "Shenzhen", region: "Guangdong", countryCode: "CN" },
        profiles: [{ network: "GitHub", url: "https://github.com/cubxxw", username: "cubxxw" }],
      },
      work: [
        {
          name: "Stripe",
          position: "Senior Engineer",
          startDate: "2021-06",
          endDate: "2024-03",
          highlights: ["Led payment gateway rewrite, QPS up 3x", "Mentored 4 engineers"],
        },
      ],
      skills: [{ name: "Languages", keywords: ["TypeScript", "Go", "Python"] }],
      education: [
        { institution: "SUSTech", studyType: "BSc", area: "Computer Science", startDate: "2017", endDate: "2021" },
      ],
    };
    const md = jsonResumeToMarkdown(resume);

    expect(md).toContain("# Xiong Xinwei");
    expect(md).toContain("_Senior Backend Engineer_");
    expect(md).toContain(
      "x@example.com · +86 138 0000 0000 · Shenzhen, Guangdong, CN · [GitHub](https://github.com/cubxxw)",
    );
    expect(md).toContain("## Summary");
    expect(md).toContain("## Experience");
    expect(md).toContain("### Senior Engineer — Stripe");
    expect(md).toContain("_Jun 2021 – Mar 2024_");
    expect(md).toContain("- Led payment gateway rewrite, QPS up 3x");
    expect(md).toContain("## Skills");
    expect(md).toContain("- **Languages** TypeScript, Go, Python");
    expect(md).toContain("## Education");
    expect(md).toContain("### BSc, Computer Science — SUSTech");
    expect(md).toContain("_2017 – 2021_");
  });

  it("maps every highlight to exactly one bullet line (bullet-line contract §4.3)", () => {
    const resume: JsonResume = {
      work: [{ name: "Acme", highlights: ["one", "two", "three"] }],
    };
    const md = jsonResumeToMarkdown(resume);
    const bulletLines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines).toEqual(["- one", "- two", "- three"]);
  });

  it("renders an ongoing role as '– Present'", () => {
    const md = jsonResumeToMarkdown({
      work: [{ name: "Acme", position: "Dev", startDate: "2023-01", highlights: ["x"] }],
    });
    expect(md).toContain("_Jan 2023 – Present_");
  });

  it("passes unparseable dates through verbatim (never fabricates a date)", () => {
    const md = jsonResumeToMarkdown({
      work: [{ name: "Acme", startDate: "Summer 2020", endDate: "Winter 2021", highlights: ["x"] }],
    });
    expect(md).toContain("_Summer 2020 – Winter 2021_");
  });

  it("omits empty sections entirely", () => {
    const md = jsonResumeToMarkdown({ basics: { name: "Solo" }, work: [], skills: [] });
    expect(md).toContain("# Solo");
    expect(md).not.toContain("## Experience");
    expect(md).not.toContain("## Skills");
  });

  it("renders skill keywords without a group name", () => {
    const md = jsonResumeToMarkdown({ skills: [{ keywords: ["Rust", "Zig"] }] });
    expect(md).toContain("## Skills");
    expect(md).toContain("- Rust, Zig");
  });

  it("renders extension sections (languages) so nothing is lost", () => {
    const md = jsonResumeToMarkdown({
      basics: { name: "A" },
      languages: [{ language: "English", fluency: "Native" }],
    } as JsonResume);
    expect(md).toContain("## Languages");
    expect(md).toContain("- **English** — Native");
  });

  it("returns empty string for empty/garbage input", () => {
    expect(jsonResumeToMarkdown(undefined)).toBe("");
    expect(jsonResumeToMarkdown(null)).toBe("");
    expect(jsonResumeToMarkdown({})).toBe("");
  });

  it("handles a tailored doc where company is under .company not .name", () => {
    const md = jsonResumeToMarkdown({
      work: [{ company: "Linear", position: "Eng", highlights: ["shipped"] } as never],
    });
    expect(md).toContain("### Eng — Linear");
  });
});
