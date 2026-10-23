import { describe, expect, test } from "bun:test";
import { LLMClient, LLMUnavailableError, repairJson, closeTruncatedJson, type FetchLike } from "./llm";

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


describe("partial JSON recovery", () => {
  test.each([
    ['{"basics":{"name":"Sam","summary":"unfinished', { basics: { name: "Sam" } }],
    ['{"items":["complete","unfinished', { items: ["complete"] }],
    ['{"items":[{"name":"First"},{"name":"Second","detail":', { items: [{ name: "First" }, { name: "Second" }] }],
    ['{"name":"Sam","danglingKey"', { name: "Sam" }],
    ['{"text":"brace } and escaped \\" quote","next":', { text: 'brace } and escaped " quote' }],
    ['{"values":[true,false,null,1.5,tru', { values: [true, false, null, 1.5] }],
    ['{"name":"Sam","number":1e', { name: "Sam" }],
  ])("preserves only completed values: %s", (raw, expected) => {
    const repaired = closeTruncatedJson(raw as string);
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!)).toEqual(expected);
  });

  test.each(["1", "123", "true", "false", "null"])("drops an EOF primitive without delimiter evidence: %s", (token) => {
    expect(JSON.parse(closeTruncatedJson(`{"name":"Sam","value":${token}`)!)).toEqual({ name: "Sam" });
  });

  test.each(["123", "true", "false", "null"].flatMap((token) => [" ", ","].map((delimiter) => [token, delimiter])))
  ("preserves a primitive with an observed delimiter: %s%s", (token, delimiter) => {
    expect(JSON.parse(closeTruncatedJson(`{"name":"Sam","value":${token}${delimiter}`)!)).toEqual({ name: "Sam", value: JSON.parse(token) });
  });

  test.each(['not json', '{"name":"unfinished', '{"x":]', '{}'])('rejects unrecoverable or complete input: %s', (raw) => {
    expect(closeTruncatedJson(raw)).toBeNull();
  });

  const truncatedClient = (finishReason: string) => new LLMClient(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"basics":{"name":"Sam"},"work":[{"name":"First"},{"name":"Second","summary":"unfinished' }, finish_reason: finishReason }],
  })), "test-key");

  test("is opt-in and reports recovery metadata", async () => {
    const client = truncatedClient("length");
    await expect(client.chatJSON([])).rejects.toBeInstanceOf(LLMUnavailableError);
    const { data, meta } = await client.chatJSON([], { allowPartialJson: true });
    expect(data).toEqual({ basics: { name: "Sam" }, work: [{ name: "First" }, { name: "Second" }] });
    expect(meta.jsonRepaired).toBe(true);
    expect(meta.finishReason).toBe("length");
  });

  test.each([
    ['{"name":"Sam","years":1', { name: "Sam" }],
    ['{"name":"Sam","years":123 ', { name: "Sam", years: 123 }],
  ])("chatJSON preserves primitive termination evidence: %s", async (content, expected) => {
    const client = new LLMClient(async () => new Response(JSON.stringify({ choices: [{
      message: { content }, finish_reason: "length",
    }] })), "test-key");
    const { data } = await client.chatJSON([], { allowPartialJson: true });
    expect(data).toEqual(expected);
  });

  test("does not recover malformed responses without an output-limit signal", async () => {
    await expect(truncatedClient("stop").chatJSON([], { allowPartialJson: true })).rejects.toBeInstanceOf(LLMUnavailableError);
  });
});
