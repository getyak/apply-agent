// Public résumé read-only delivery (the share-link surface).
//
// GET /api/public/r/:token
//   No auth. Looks up a published résumé by its unguessable token (32 hex
//   chars, ~2^128 keyspace), returns the JSON Resume payload + just enough
//   metadata for the public page (basics.name and publishedAt). Never exposes
//   user_id, email, file IDs, or any other side-channel that would let a
//   recruiter or scraper pivot from a public résumé to identity attributes.
//
// Security posture:
//   · One 404 for "token not found", "token revoked", and "wrong format" —
//     we never tell the client which of the three it is (no enumeration).
//   · No auth middleware in front of this router (it's mounted outside the
//     authed prefix) — that is the WHOLE point. Don't add it.
//   · Rate-limited per-IP to defeat dictionary scans of the keyspace.
//   · Token lookups are O(1) via the partial unique index from migration 018.

import { Hono } from "hono";
import { query } from "../db";
import { rateLimit } from "../middleware/rate-limit";
import { NotFoundError } from "../errors";
import { jsonResumeToMarkdown } from "../resume-markdown";
import { resolveLocale } from "../locale";
import type { JsonResume } from "../resume-parse";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

// IP-scoped rate limit. Tokens are 16-byte hex (2^128 entropy) so blind
// enumeration is already infeasible — this is belt-and-suspenders against
// a scripted scan that hits the endpoint thousands of times a minute.
const publicReadLimiter = rateLimit({
  scope: "public_resume_read",
  limit: 60,
  windowSeconds: 60,
  keyFor: (c) =>
    c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "anon",
});

app.use("*", publicReadLimiter);

app.get("/:token", async (c) => {
  const token = c.req.param("token") ?? "";
  // Cheap shape check first — keeps obvious junk away from the DB.
  if (!/^[a-f0-9]{32}$/.test(token)) {
    throw new NotFoundError("Résumé not available");
  }

  const result = await query<{
    content: unknown;
    version: number;
    published_at: string;
  }>(
    `SELECT content, version, published_at
       FROM resumes
       WHERE publish_token = $1`,
    [token],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError("Résumé not available");
  }

  const row = result.rows[0];
  // Public share has no logged-in user, so locale falls through to
  // X-Relay-Locale (if a logged-in viewer's browser sends it) → Accept-Language
  // → "en". The persisted markdown wins whenever present — it was rendered
  // under the publishing user's locale at write time.
  const { parsed, markdown } = unwrapForPublic(row.content, resolveLocale(c));

  return c.json({
    // basics only — never expose user_id, email, file ids, etc.
    basics: {
      name: parsed.basics?.name ?? null,
      label: parsed.basics?.label ?? null,
    },
    parsed,
    markdown,
    version: row.version,
    publishedAt: row.published_at,
  });
});

/**
 * Pull the JSON Resume + canonical Markdown out of either:
 *   · the new wrapper shape (envelope with `parsed` + `markdown` keys), or
 *   · the legacy flat shape (basics/work/skills at the top level).
 *
 * In both cases we recompute markdown when absent so the public page always
 * has a string to render — no client-side JSON-to-MD work.
 */
function unwrapForPublic(content: unknown, locale: "en" | "zh" = "en"): {
  parsed: JsonResume;
  markdown: string;
} {
  if (
    content &&
    typeof content === "object" &&
    "parsed" in (content as Record<string, unknown>)
  ) {
    const env = content as { parsed: JsonResume; markdown?: string };
    const md =
      typeof env.markdown === "string" && env.markdown.length > 0
        ? env.markdown
        : jsonResumeToMarkdown(env.parsed, { locale });
    return { parsed: env.parsed, markdown: md };
  }
  const flat = (content ?? {}) as JsonResume;
  return { parsed: flat, markdown: jsonResumeToMarkdown(flat, { locale }) };
}

export default app;
