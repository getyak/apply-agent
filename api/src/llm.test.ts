import { describe, expect, test } from "bun:test";
import { LLMClient, LLMUnavailableError, repairJson, type FetchLike } from "./llm";

// Build a fake fetch returning a canned OpenRouter chat-completion payload.
function okFetch(content: string, usage = { prompt_tokens: 100, completion_tokens: 50 }): {
  fetchImpl: FetchLike;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        choices: [{ message: { content } }],
        usage,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetchImpl, calls };
}

describe("repairJson", () => {
  test("strips ```json fences", () => {
    expect(repairJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("strips bare ``` fences", () => {
    expect(repairJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("removes trailing commas", () => {
    expect(repairJson('{"a":1,"b":2,}')).toBe('{"a":1,"b":2}');
    expect(repairJson('[1,2,3,]')).toBe("[1,2,3]");
  });

  test("slices object out of surrounding prose", () => {
    expect(repairJson('Here is the result: {"a":1} hope that helps')).toBe('{"a":1}');
  });

  test("leaves clean json untouched", () => {
    expect(repairJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe("LLMClient.available", () => {
  test("false when key empty", () => {
    const c = new LLMClient(okFetch("x").fetchImpl, "");
    expect(c.available).toBe(false);
  });
  test("true when key present", () => {
    const c = new LLMClient(okFetch("x").fetchImpl, "sk-test");
    expect(c.available).toBe(true);
  });
});

describe("LLMClient.chat", () => {
  test("throws LLMUnavailableError without a key", async () => {
    const c = new LLMClient(okFetch("x").fetchImpl, "");
    await expect(c.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      LLMUnavailableError,
    );
  });

  test("returns text, usage and computed cost", async () => {
    const { fetchImpl } = okFetch("hello world");
    const c = new LLMClient(fetchImpl, "sk-test");
    const r = await c.chat([{ role: "user", content: "hi" }], { tier: "fast" });
    expect(r.text).toBe("hello world");
    expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(r.costCents).toBeGreaterThan(0);
    expect(r.model).toBe("deepseek/deepseek-v4-flash");
  });

  test("sends response_format only when json requested", async () => {
    const { fetchImpl, calls } = okFetch('{"ok":true}');
    const c = new LLMClient(fetchImpl, "sk-test");
    await c.chat([{ role: "user", content: "hi" }], { json: true });
    expect((calls[0].body as Record<string, unknown>).response_format).toEqual({
      type: "json_object",
    });
  });

  test("maps non-2xx to LLMUnavailableError", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("rate limited", { status: 429 });
    const c = new LLMClient(fetchImpl, "sk-test");
    await expect(c.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      LLMUnavailableError,
    );
  });

  test("maps network throw to LLMUnavailableError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const c = new LLMClient(fetchImpl, "sk-test");
    await expect(c.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      LLMUnavailableError,
    );
  });
});

describe("LLMClient.chatJSON", () => {
  test("parses clean json", async () => {
    const { fetchImpl } = okFetch('{"agent":"resume_agent","reply":"hi"}');
    const c = new LLMClient(fetchImpl, "sk-test");
    const { data } = await c.chatJSON<{ agent: string; reply: string }>([
      { role: "user", content: "x" },
    ]);
    expect(data.agent).toBe("resume_agent");
    expect(data.reply).toBe("hi");
  });

  test("repairs fenced json before parsing", async () => {
    const { fetchImpl } = okFetch('```json\n{"score":5,}\n```');
    const c = new LLMClient(fetchImpl, "sk-test");
    const { data } = await c.chatJSON<{ score: number }>([
      { role: "user", content: "x" },
    ]);
    expect(data.score).toBe(5);
  });

  test("throws LLMUnavailableError on unrepairable json", async () => {
    const { fetchImpl } = okFetch("not json at all <<>>");
    const c = new LLMClient(fetchImpl, "sk-test");
    await expect(
      c.chatJSON([{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(LLMUnavailableError);
  });

  test("returns meta without text field", async () => {
    const { fetchImpl } = okFetch('{"a":1}');
    const c = new LLMClient(fetchImpl, "sk-test");
    const { meta } = await c.chatJSON([{ role: "user", content: "x" }]);
    expect(meta).toHaveProperty("model");
    expect(meta).toHaveProperty("costCents");
    expect(meta).not.toHaveProperty("text");
  });
});
