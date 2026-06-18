// Single source of truth for the TypeScript API origin (Hono/Bun, default
// :3001). Both the JSON client (api.ts) and the Ask Vantage SSE client
// (ask-stream.ts) import this so they can never drift onto different bases.
//
// IMPORTANT — why these are written as two *separate* static reads:
// Next.js inlines `process.env.NEXT_PUBLIC_*` at BUILD time, but ONLY for the
// literal `process.env.NEXT_PUBLIC_FOO` form. A dynamic lookup
// (`process.env[name]` / `const e = process.env; e.NEXT_PUBLIC_FOO`) is NOT
// inlined and resolves to `undefined` in the browser bundle
// (node_modules/next/dist/docs/01-app/02-guides/environment-variables.md
// § "Bundling Environment Variables for the Browser"). So we read each name
// directly and fall back through them.
//
// Name precedence:
//   1. NEXT_PUBLIC_API_BASE — canonical name (matches ask-stream's historical
//      deployment override and the "base URL" convention).
//   2. NEXT_PUBLIC_API_URL  — back-compat alias (what web/.env.local ships).
//   3. http://localhost:3001 — literal default so dev works with no env file
//      at all (the default is inlined regardless of whether either var is set,
//      which is what guarantees the client bundle reaches :3001 out of the box
//      and never falls back to a relative `/api/...` URL).
const RAW_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:3001";

// Strip a single trailing slash so callers can safely do `${API_BASE}${path}`
// where path always starts with "/".
export const API_BASE = RAW_BASE.replace(/\/$/, "");
