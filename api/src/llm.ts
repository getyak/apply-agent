import { config } from "./config";

// Real OpenRouter client (NOT the Claude API). Talks the OpenAI-compatible
// /chat/completions endpoint over fetch — no SDK dependency, which keeps the
// Bun bundle small and the wire format inspectable.
//
// Design notes:
//   - Three model tiers (heavy/general/fast) map to OpenRouter IDs in config.
//   - chatJSON() forces and *repairs* JSON output. DeepSeek/GLM via OpenRouter
//     occasionally wrap JSON in ``` fences or emit trailing commas; a single
//     bad token must not crash a route, so we repair before JSON.parse.
//   - Cost comes from the provider-reported `usage` field, never a local
//     tiktoken estimate (providers count differently — see harness doc).
//   - When no API key is configured, calls throw LLMUnavailableError so every
//     caller can fall back to a deterministic path instead of 500-ing.

export type ModelTier = "heavy" | "general" | "fast";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  tier?: ModelTier;
  /** Sampling temperature; lower = more deterministic. Default 0.7. */
  temperature?: number;
  /** Hard cap on completion tokens. Default 1024. */
  maxTokens?: number;
  /** Ask the provider for a JSON object response. Used by chatJSON(). */
  json?: boolean;
  /** Abort the request after this many ms. Default 60_000. */
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  /** Estimated cost in US cents, from the provider usage field + pricing. */
  costCents: number;
}

/** Per-1M-token USD pricing (input/output) keyed by OpenRouter model id. */
const PRICING: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-v4-pro": { in: 0.435, out: 0.87 },
  "z-ai/glm-4.7": { in: 0.4, out: 1.75 },
  "deepseek/deepseek-v4-flash": { in: 0.098, out: 0.196 },
};

/** Thrown when the LLM cannot be reached (no key, network, or upstream error). */
export class LLMUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

function tierToModel(tier: ModelTier): string {
  switch (tier) {
    case "heavy":
      return config.OPENROUTER_MODEL_HEAVY;
    case "fast":
      return config.OPENROUTER_MODEL_FAST;
    default:
      return config.OPENROUTER_MODEL_GENERAL;
  }
}

function costCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const usd =
    (promptTokens / 1_000_000) * p.in +
    (completionTokens / 1_000_000) * p.out;
  return Math.round(usd * 100 * 10_000) / 10_000; // cents, 4dp
}

/**
 * Best-effort repair of almost-JSON the model returned. Handles the common
 * OpenRouter-via-DeepSeek/GLM failure modes: markdown code fences, leading
 * prose, and trailing commas. Returns the cleaned string (still parse it).
 */
export function repairJson(raw: string): string {
  let s = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  // If there's prose around the object/array, slice to the outermost braces.
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  const start =
    firstArr === -1
      ? firstObj
      : firstObj === -1
        ? firstArr
        : Math.min(firstObj, firstArr);
  if (start > 0) {
    const openCh = s[start];
    const closeCh = openCh === "{" ? "}" : "]";
    const end = s.lastIndexOf(closeCh);
    if (end > start) s = s.slice(start, end + 1);
  }

  // Remove trailing commas before } or ].
  s = s.replace(/,(\s*[}\]])/g, "$1");

  return s.trim();
}

/** The subset of `fetch` we depend on; injectable for tests. */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export class LLMClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly apiKey: string = config.OPENROUTER_API_KEY,
    private readonly baseUrl: string = config.OPENROUTER_BASE_URL,
  ) {}

  /** True when a real key is present and live calls will be attempted. */
  get available(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    if (!this.available) {
      throw new LLMUnavailableError("OPENROUTER_API_KEY is not configured");
    }

    const model = tierToModel(opts.tier ?? "general");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? 60_000,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter attribution headers (optional but recommended).
          "HTTP-Referer": "https://relay.app",
          "X-Title": "Relay",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.7,
          max_tokens: opts.maxTokens ?? 1024,
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LLMUnavailableError("OpenRouter request failed", err);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new LLMUnavailableError(
        `OpenRouter returned ${res.status}: ${detail.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    // GLM-4.7 (and some other reasoning models) on certain OpenRouter providers
    // place the JSON-mode response inside `reasoning` while leaving `content`
    // empty. Fall back to `reasoning` when `content` is blank so JSON-mode
    // callers (chatJSON) don't spuriously fail.
    const choice = data.choices?.[0]?.message;
    const rawContent = (choice?.content ?? "").trim();
    const text = rawContent.length > 0 ? (choice!.content as string) : (choice?.reasoning ?? "");
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const usedModel = data.model ?? model;

    return {
      text,
      model: usedModel,
      usage: { promptTokens, completionTokens },
      costCents: costCents(usedModel, promptTokens, completionTokens),
    };
  }

  /**
   * Chat that returns a parsed JSON object of type T. Forces json mode and
   * applies repairJson() before parsing so malformed-but-recoverable output
   * doesn't throw. Throws LLMUnavailableError if even the repaired text won't
   * parse — callers fall back deterministically.
   */
  async chatJSON<T>(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<{ data: T; meta: Omit<ChatResult, "text"> }> {
    const result = await this.chat(messages, { ...opts, json: true });
    const cleaned = repairJson(result.text);
    let data: T;
    try {
      data = JSON.parse(cleaned) as T;
    } catch (err) {
      throw new LLMUnavailableError(
        `Model returned unparseable JSON: ${cleaned.slice(0, 200)}`,
        err,
      );
    }
    const { text: _omit, ...meta } = result;
    return { data, meta };
  }
}

/** Process-wide client using the real fetch + configured key. */
export const llm = new LLMClient();
