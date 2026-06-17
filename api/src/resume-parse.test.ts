import { describe, expect, test } from "bun:test";
import { parseResumeText } from "./resume-parse";
import { LLMClient, LLMUnavailableError, type FetchLike } from "./llm";

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

  test("throws when no LLM is configured (never fabricates)", async () => {
    const noKey = new LLMClient(
      (async () => new Response("{}")) as FetchLike,
      "",
    );
    await expect(parseResumeText("anything", noKey)).rejects.toBeInstanceOf(
      LLMUnavailableError,
    );
  });

  test("throws when the model returns an empty / structureless object", async () => {
    await expect(
      parseResumeText("garbage", llmReturning("{}")),
    ).rejects.toBeInstanceOf(LLMUnavailableError);
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
