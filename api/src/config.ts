import { z } from "zod";

// Centralized, validated configuration. Parsed once at module load so the
// process fails fast at boot when a required env var is missing or malformed,
// instead of throwing deep inside a request handler.

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_PORT: z.coerce.number().int().positive().default(3001),

  // Datastores — defaults match the non-standard local ports (PG 5433 / Redis 6380).
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://relay:relay@localhost:5433/relay"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6380/0"),

  // Auth — a weak fallback is tolerated in dev/test but rejected in production
  // (see refine below) so we never ship the placeholder secret.
  JWT_SECRET: z.string().min(1).default("dev-secret-change-me"),

  // Comma-separated allowlist of CORS origins.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  // LLM access via OpenRouter (NOT the Claude API directly). The key is
  // optional: when absent, AI routes degrade to deterministic fallbacks
  // instead of failing, so the API boots and serves in key-less envs (CI,
  // local smoke tests). `chat()` callers must handle the degraded path.
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_BASE_URL: z
    .string()
    .url()
    .default("https://openrouter.ai/api/v1"),

  // Three-tier model routing (OpenRouter IDs). Heavy = deep reasoning
  // (interview eval, complex match); general = balanced (resume, cover
  // letters, chat); fast = cheap/bulk (JD parse, skill extraction).
  // Overridable so model upgrades need no code change.
  //
  // Two env-var names are accepted for each tier: the canonical OPENROUTER_MODEL_*
  // and the shorthand LLM_MODEL_* (which some .env files use). The preprocess
  // below maps the LLM_MODEL_* alias onto the canonical key when the canonical
  // one is absent, so either spelling works.
  OPENROUTER_MODEL_HEAVY: z.string().default("deepseek/deepseek-v4-pro"),
  OPENROUTER_MODEL_GENERAL: z.string().default("z-ai/glm-4.7"),
  OPENROUTER_MODEL_FAST: z.string().default("deepseek/deepseek-v4-flash"),

  // Markdown conversion provider for the resume pipeline (upload → markdown →
  // JSON Resume). "off" uses only the pure-JS L0 layer (mammoth+turndown for
  // DOCX, unpdf heuristics for PDF). A named provider (e.g. "llamaparse") opts
  // into an L1 layer over HTTP for complex layouts, always falling back to L0.
  // Defaults off so the API needs no extra service and incurs no cost.
  MARKDOWN_PROVIDER: z.string().default("off"),

  // Object storage (MinIO locally, S3-compatible in prod). Defaults target the
  // local MinIO from infra/docker-compose.yml (API on :9000). Like the LLM key,
  // S3_ACCESS_KEY is optional: when absent, the storage client reports itself
  // unavailable and file-upload routes degrade instead of 500-ing, so the API
  // still boots in storage-less envs (CI unit tests).
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_KEY: z.string().default(""),
  S3_BUCKET: z.string().default("relay-user-files"),
  S3_REGION: z.string().default("us-east-1"),
});

export type Env = z.infer<typeof EnvSchema> & {
  /** Parsed CORS origins as a list (derived from CORS_ORIGINS). */
  corsOrigins: string[];
};

function loadConfig(source: NodeJS.ProcessEnv = process.env): Env {
  // Accept LLM_MODEL_* as an alias for OPENROUTER_MODEL_* (some .env files use
  // the shorthand). Canonical key wins when both are set; we never overwrite an
  // explicit OPENROUTER_MODEL_*.
  const withAliases: NodeJS.ProcessEnv = { ...source };
  const modelAliases: [canonical: string, alias: string][] = [
    ["OPENROUTER_MODEL_HEAVY", "LLM_MODEL_HEAVY"],
    ["OPENROUTER_MODEL_GENERAL", "LLM_MODEL_GENERAL"],
    ["OPENROUTER_MODEL_FAST", "LLM_MODEL_FAST"],
  ];
  for (const [canonical, alias] of modelAliases) {
    if (!withAliases[canonical] && withAliases[alias]) {
      withAliases[canonical] = withAliases[alias];
    }
  }

  const parsed = EnvSchema.safeParse(withAliases);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // Hard production safety: never run prod with the placeholder secret.
  if (env.NODE_ENV === "production" && env.JWT_SECRET === "dev-secret-change-me") {
    throw new Error(
      "Invalid environment configuration:\n  - JWT_SECRET: must be set to a real secret in production",
    );
  }

  return {
    ...env,
    corsOrigins: env.CORS_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

export const config: Env = loadConfig();

// Exported for unit tests that want to validate arbitrary env shapes.
export { loadConfig, EnvSchema };
