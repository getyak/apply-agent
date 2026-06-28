#!/usr/bin/env node
/**
 * Web hydration smoke test.
 *
 * Per docs/architecture/cicd-aiops-harness.md §3 ("CI gate: a Playwright
 * smoke that asserts a `__reactFiber*` key on a button — hydration is a
 * dev-experience red line"). This is the bare-minimum red-line check
 * that test-run-2026-06-18 found a regression in:
 *
 *   Symptom: SSR shipped HTML, client never hydrated → every onClick was
 *   a no-op, every page stuck at <p>Loading…</p>.
 *
 * What it checks (per route):
 *   1. HTTP 200 (or any 2xx) returned by the server
 *   2. SSR HTML contains a recognisable Next.js boot marker
 *   3. Client successfully hydrates, exposed by a __reactFiber* / __reactProps*
 *      key on a button element. We pick a button because every Vantage
 *      route ships one in its header.
 *
 * Usage:
 *   # 1) make sure the dev or prod server is up:
 *   cd web && bun run dev          # OR: bun run build && bun run start
 *   # 2) run the smoke:
 *   node scripts/web-hydration-smoke.mjs --base-url http://127.0.0.1:3000
 *
 * Playwright is fetched on demand with `bunx playwright`. Not added to
 * web/package.json — keeps the runtime lock file untouched. CI wiring is
 * deferred (see scripts/README or test.md changelog 2026-06-18) because
 * .github/workflows/ci.yml currently targets the wrong package manager
 * (pnpm) and the wrong path (apps/web/), so we cannot meaningfully add
 * a green check yet.
 *
 * Exit code: 0 on success, 1 on any failure. JSON line for each route is
 * printed to stdout so a future CI step can grep / parse it.
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args["base-url"] ?? "http://127.0.0.1:3000";
const ROUTES = (args.routes ?? "/,/auth,/legal/privacy").split(",");
const TIMEOUT_MS = Number(args.timeout ?? 15000);

/**
 * Probe 1: SSR reachability. If this fails we don't even try to launch a
 * browser — most likely cause is the dev server isn't running.
 */
async function probeSsr(route) {
  const url = new URL(route, BASE_URL).toString();
  const res = await fetch(url, { redirect: "follow" });
  const html = await res.text();
  const ok = res.status >= 200 && res.status < 400;
  // Next 16 boots through chunks loaded by /_next/static — the URL alone
  // is a robust marker that the SSR shell intends to hydrate at all.
  const hasNextChunks = html.includes("/_next/static/");
  return { url, status: res.status, ok, hasNextChunks, bytes: html.length };
}

/**
 * Probe 2: actual hydration. Spawn `bunx playwright` to render the page
 * in a real Chromium and inspect a button DOM node for a React fiber key.
 *
 * We do this in a sub-process so the smoke script itself has zero deps —
 * importable on any machine with bun/node, no pnpm install required.
 */
async function probeHydration(route) {
  const url = new URL(route, BASE_URL).toString();
  return new Promise((resolve) => {
    // `bunx playwright -e <code>` doesn't work — playwright's CLI doesn't
    // accept `-e`. Write the probe to a temp file and run it under npx with
    // playwright on demand (`--package=playwright`). npx installs playwright
    // into a cache dir, downloads the bundled chromium, then runs node on
    // the script with NODE_PATH pointing at that cache so `require("playwright")`
    // resolves. This is the standard "ephemeral playwright" recipe.
    const code = `
      const { chromium } = require("playwright");
      (async () => {
        const browser = await chromium.launch();
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const started = Date.now();
        await page.goto(${JSON.stringify(url)}, {
          waitUntil: "load",
          timeout: ${TIMEOUT_MS},
        });
        // Give React a beat to flush its first hydrate pass.
        await page.waitForLoadState("networkidle", { timeout: ${TIMEOUT_MS} }).catch(() => {});
        const hydrated = await page.evaluate(() => {
          const btn = document.querySelector("button");
          if (!btn) return { ok: false, reason: "no <button> on page" };
          // React injects a __reactFiber\$randomKey + __reactProps\$randomKey
          // on every host DOM node it owns. Either is sufficient evidence
          // that the client took ownership of the SSR'd markup.
          const keys = Object.keys(btn).filter((k) =>
            k.startsWith("__reactFiber") || k.startsWith("__reactProps"),
          );
          return { ok: keys.length > 0, reason: keys.length ? null : "no fiber keys" };
        });
        const durationMs = Date.now() - started;
        await browser.close();
        process.stdout.write(JSON.stringify({ ...hydrated, durationMs }));
      })().catch((e) => {
        process.stdout.write(JSON.stringify({ ok: false, reason: String(e?.message ?? e), durationMs: -1 }));
        process.exit(0);
      });
    `;
    // CJS extension forces node to use require() semantics for require("playwright").
    // NODE_PATH (set by ci.yml's hydration-smoke step or inherited from a
    // local global install) is how playwright is found at the require step.
    const tmpFile = join(
      tmpdir(),
      `hydration-probe-${process.pid}-${Date.now()}.cjs`,
    );
    writeFileSync(tmpFile, code, "utf8");
    const child = spawn("node", [tmpFile], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      try {
        unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup
      }
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
      } catch {
        resolve({ ok: false, reason: "could not parse playwright output", durationMs: -1 });
      }
    });
  });
}

let failures = 0;
for (const route of ROUTES) {
  let ssr;
  try {
    ssr = await probeSsr(route);
  } catch (e) {
    failures += 1;
    console.log(JSON.stringify({ route, stage: "ssr", ok: false, reason: String(e?.message ?? e) }));
    continue;
  }
  if (!ssr.ok || !ssr.hasNextChunks) {
    failures += 1;
    console.log(
      JSON.stringify({
        route,
        stage: "ssr",
        url: ssr.url,
        status: ssr.status,
        bytes: ssr.bytes,
        hasNextChunks: ssr.hasNextChunks,
        ok: false,
        reason: !ssr.ok ? `HTTP ${ssr.status}` : "no /_next/static/ markers in SSR HTML",
      }),
    );
    continue;
  }
  const h = await probeHydration(route);
  if (!h.ok) failures += 1;
  console.log(
    JSON.stringify({
      route,
      stage: "hydration",
      url: ssr.url,
      status: ssr.status,
      hasNextChunks: true,
      hydrated: h.ok,
      reason: h.reason ?? null,
      durationMs: h.durationMs,
    }),
  );
}

const summary = {
  baseUrl: BASE_URL,
  routes: ROUTES.length,
  failures,
  ok: failures === 0,
};
console.log(JSON.stringify({ summary }));
process.exit(summary.ok ? 0 : 1);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}
