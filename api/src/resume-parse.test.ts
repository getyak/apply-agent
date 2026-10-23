import { describe, expect, test } from "bun:test";
import { parseResumeText, parseTextOverlap } from "./resume-parse";
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


describe("resume text preservation", () => {
  test("sends a bounded 24k prefix, preserves the original, and warns even with high overlap", async () => {
    const raw = "Original content ".repeat(2000);
    let request: Record<string, unknown> = {};
    const client = new LLMClient(async (_, init) => {
      request = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ basics: { summary: raw } }) } }] }));
    }, "test-key");
    const out = await parseResumeText(raw, client);
    expect(out.raw).toBe(raw.trim());
    const messages = request.messages as { role: string; content: string }[];
    expect(messages[1].content).toBe(`Resume text:\n\n${raw.trim().slice(0, 24000)}`);
    expect(request.max_tokens).toBe(16000);
    expect(messages[0].content).toContain("NEVER silently drop a section");
    expect(messages[0].content).toContain("Do NOT invent");
    expect(messages[0].content).toContain("without repeating it across sections");
    expect(out.warnings.join(" ")).toContain("first 24,000 characters");
  });

  test("warns on repaired output and retains complete fields without inventing the tail", async () => {
    const client = new LLMClient(async () => new Response(JSON.stringify({ choices: [{
      message: { content: '{"basics":{"name":"Sam"},"projects":[{"name":"Parser","description":"unfinished' }, finish_reason: "length",
    }] })), "test-key");
    const out = await parseResumeText("Sam Parser unfinished", client);
    expect(out.usedFallback).toBe(false);
    expect(out.resume.projects).toEqual([{ name: "Parser" }]);
    expect(out.warnings.join(" ")).toContain("output limit");
    expect(out.raw).toBe("Sam Parser unfinished");
  });

  test("warns on length limit even when JSON is syntactically complete", async () => {
    const client = new LLMClient(async () => new Response(JSON.stringify({ choices: [{
      message: { content: '{"basics":{"name":"Sam"}}' }, finish_reason: "length",
    }] })), "test-key");
    const out = await parseResumeText("Sam", client);
    expect(out.warnings.join(" ")).toContain("output limit");
  });

  test("keeps project and extension-only resumes without a false empty warning", async () => {
    const doc = { projects: [{ name: "Parser", description: "Complete source" }], certificates: [{ name: "Certificate", issuer: "Institute", courses: ["One", "Two"] }] };
    const out = await parseResumeText("Parser Complete source Certificate Institute One Two", llmReturning(JSON.stringify(doc)));
    expect(out.resume).toEqual(doc);
    expect(out.warnings).toEqual([]);
  });

  test("recognises object-valued extension sections but rejects a top-level array", async () => {
    const object = await parseResumeText("Chinese Native", llmReturning('{"languages":{"name":"Chinese","fluency":"Native"}}'));
    expect(object.warnings).toEqual([]);
    const array = await parseResumeText("Sam", llmReturning('[{"name":"Sam"}]'));
    expect(array.resume).toEqual({ basics: {}, work: [], education: [], skills: [], projects: [] });
    expect(array.warnings.join(" ")).toContain("no resume structure");
  });

  test("warns on low overlap without claiming a retained-content percentage", async () => {
    const out = await parseResumeText("Extensive original experience and unique project achievements ".repeat(20), llmReturning('{"basics":{"name":"Sam"}}'));
    expect(out.warnings.join(" ")).toContain("low text overlap");
    expect(out.warnings.join(" ")).not.toContain("%");
  });

  test("duplicate or unrelated generated text cannot inflate character overlap", () => {
    expect(parseTextOverlap({ basics: { summary: "a".repeat(1000) } }, "abcdefghij")).toBe(0.1);
    expect(parseTextOverlap({ basics: { summary: "ZZZZ" } }, "abcdefghij")).toBe(0);
    expect(parseTextOverlap({ _raw: "abcdefghij" }, "abcdefghij")).toBe(0);
    expect(parseTextOverlap({ basics: { summary: "原始项目内容" } }, "原始·项目·内容")).toBe(1);
  });
});
