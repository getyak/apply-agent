import { describe, expect, test } from "bun:test";
import { parseResumeText } from "./resume-parse";
import { LLMClient, type FetchLike } from "./llm";

// A fake OpenRouter that returns whatever JSON content we hand it, so we can
// drive parseResumeText without a live model.
function llmReturning(content: string): LLMClient {
  const fetchImpl: FetchLike = async () =>
    new Response(
      JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  // Non-empty key so `available` is true.
  return new LLMClient(fetchImpl, "test-key");
}

describe("parseResumeText", () => {
  test("returns the structured resume when the model responds", async () => {
    const resumeJson = JSON.stringify({
      basics: { name: "Sam Rivera", label: "Backend Engineer" },
      skills: [{ name: "Go" }, { name: "PostgreSQL" }],
      work: [{ name: "Acme", position: "Engineer" }],
    });
    const { resume, meta } = await parseResumeText(
      "Sam Rivera — Backend Engineer. Skills: Go, PostgreSQL.",
      llmReturning(resumeJson),
    );
    expect(resume.basics?.name).toBe("Sam Rivera");
    expect(resume.skills?.map((s) => s.name)).toEqual(["Go", "PostgreSQL"]);
    expect(meta.model).toBe("deepseek/deepseek-v4-flash");
    expect(meta.costCents).toBeGreaterThan(0);
  });

  test("honest-degrades when no LLM is configured (raw text saved, never fabricates)", async () => {
    // Contract change captured by [[feedback_onboarding_real_parse.md]]:
    // we never throw away the user's upload. With no LLM we return an
    // empty-shape resume plus a user-visible warning, and the raw text rides
    // along so the caller can persist a usable v1 base.
    const noKey = new LLMClient(
      (async () => new Response("{}")) as FetchLike,
      "",
    );
    const out = await parseResumeText("anything", noKey);
    expect(out.usedFallback).toBe(true);
    expect(out.raw).toBe("anything");
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings.join(" ")).toMatch(/offline|saved as-is/i);
    expect(out.meta.model).toBe("none");
  });

  test("warns when the model returns an empty / structureless object (does not throw)", async () => {
    const out = await parseResumeText("garbage", llmReturning("{}"));
    // The model "succeeded" but the shape is empty — we keep the raw text
    // and surface a warning rather than treating it as a hard failure.
    expect(out.usedFallback).toBe(false);
    expect(out.raw).toBe("garbage");
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  test("tolerates a resume with only a work section", async () => {
    const { resume } = await parseResumeText(
      "Worked at Globex as a PM 2019-2022",
      llmReturning(
        JSON.stringify({ work: [{ name: "Globex", position: "PM" }] }),
      ),
    );
    expect(resume.work?.[0]?.name).toBe("Globex");
  });
});
