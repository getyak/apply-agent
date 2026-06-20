#!/usr/bin/env node
/**
 * Web route smoke test (HTTP only).
 *
 * Per docs/ux-agent-intelligence-audit-localhost-3000.md §P0 ("加 route
 * smoke") — guards the entry routes that a new user must traverse before
 * they can do anything. The 2026-06-19 audit found `/auth` hanging
 * indefinitely; a dev that ships without `/auth` resolving in <10s breaks
 * the entire registration → workspace flow.
 *
 * What it checks per route:
 *   1. HTTP responds within --timeout (default 10s)
 *   2. status is the expected class — usually 2xx, optionally a 3xx with
 *      a known Location
 *   3. body bytes ≥ minimum, body contains the expected marker text
 *
 * Routes covered by default:
 *   /                       → 200, contains "VANTAGE"
 *   /auth                   → 200, contains "Welcome back" OR "Start your hunt"
 *   /legal/privacy          → 200, contains "Privacy"
 *
 * `/app/*` are auth-gated client side; we don't probe them here — the
 * hydration smoke and end-to-end tests cover that path.
 *
 * Usage:
 *   cd web && bun run dev
 *   node scripts/web-route-smoke.mjs --base-url http://127.0.0.1:3000
 *
 * Exit code: 0 on success, 1 if any route fails. One JSON line per route
 * is printed so CI can grep / parse it without re-running.
 */

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args["base-url"] ?? "http://127.0.0.1:3000";
const TIMEOUT_MS = Number(args.timeout ?? 10000);

/** Route → contract. `markers` are case-insensitive substrings; ANY match passes. */
const ROUTES = [
  {
    path: "/",
    expectStatus: 200,
    markers: ["VANTAGE", "Your job hunt"],
    minBytes: 1000,
  },
  {
    path: "/auth",
    expectStatus: 200,
    markers: ["Welcome back", "Start your hunt", "VANTAGE"],
    minBytes: 1000,
  },
  {
    path: "/legal/privacy",
    expectStatus: 200,
    markers: ["Privacy"],
    minBytes: 500,
  },
];

/**
 * Fetch with a hard deadline. Most Next.js "hangs" we have seen during dev
 * never return a response at all, so a deadline (vs an idle timeout) is
 * what we actually want.
 */
async function fetchWithDeadline(url, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body, ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(id);
  }
}

function checkMarkers(body, markers) {
  if (!markers || markers.length === 0) return true;
  const lower = body.toLowerCase();
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

let failed = 0;
const startedAt = Date.now();
for (const route of ROUTES) {
  const url = new URL(route.path, BASE_URL).toString();
  const t0 = Date.now();
  const res = await fetchWithDeadline(url, TIMEOUT_MS);
  const latency_ms = Date.now() - t0;

  let pass = false;
  const reasons = [];
  if (!res.ok) {
    reasons.push(`fetch failed: ${res.error}`);
  } else {
    if (route.expectStatus && res.status !== route.expectStatus) {
      reasons.push(`status ${res.status} (expected ${route.expectStatus})`);
    }
    const bytes = res.body.length;
    if (route.minBytes && bytes < route.minBytes) {
      reasons.push(`body too small (${bytes}b < ${route.minBytes}b)`);
    }
    if (!checkMarkers(res.body, route.markers)) {
      reasons.push(
        `none of [${route.markers.join(", ")}] found in body (${bytes}b)`,
      );
    }
    pass = reasons.length === 0;
  }

  const line = JSON.stringify({
    route: route.path,
    url,
    pass,
    status: res.status ?? null,
    latency_ms,
    bytes: res.ok ? res.body.length : 0,
    reasons,
  });
  process.stdout.write(line + "\n");
  if (!pass) failed++;
}

const summary = JSON.stringify({
  summary: true,
  total: ROUTES.length,
  passed: ROUTES.length - failed,
  failed,
  total_ms: Date.now() - startedAt,
});
process.stdout.write(summary + "\n");
process.exit(failed === 0 ? 0 : 1);
