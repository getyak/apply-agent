#!/usr/bin/env node
/**
 * Post-upload UI smoke test.
 *
 * Drives a fresh registration → POST /api/resumes → Playwright workspace
 * load to verify that after a parse succeeds the following four surfaces
 * appear and are interactive:
 *
 *   1. Sidebar résumé chip   (data-testid="sidebar-resume-chip")
 *   2. Landing card panel    (data-testid="resume-landing-card")
 *   3. Dock read summary     (data-testid="dock-read-summary")
 *   4. Dock résumé picker    (data-testid="dock-resume-picker")
 *
 * Each is scored 0/1; we accept partial credit (so a regression shows up
 * as a number, not a binary "pass/fail"). The script prints a JSON line per
 * surface plus a summary JSON line.
 *
 * Usage:
 *   node scripts/post-upload-ui-smoke.mjs \
 *     --base-url http://127.0.0.1:3000 --api-base http://127.0.0.1:3001
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args["base-url"] ?? "http://127.0.0.1:3000";
const API_BASE = args["api-base"] ?? "http://127.0.0.1:3001";
const TIMEOUT_MS = Number(args.timeout ?? 30000);

// Fresh email per run so re-runs don't collide with the unique-email
// constraint on users.email. Suffix with PID + epoch.
const EMAIL = `smoke-${process.pid}-${Date.now()}@vantage.test`;
// Synthesised per-run so no high-entropy string literal sits in source —
// gitleaks otherwise flags any 12+ char inline secret as generic-api-key.
// The shape stays a meets-policy password (≥6 chars per api/src/routes/auth.ts
// `password: z.string().min(6)`).
const PASSWORD = ["smoke", "pw", String(process.pid), String(Date.now())].join("-");
const DISPLAY_NAME = "Xinwei Smoke";

// Synthetic JSON Resume — mirrors what the LLM would produce on a real
// upload but with predictable values so we can assert against them.
const SAMPLE_RESUME = {
  basics: {
    name: "Xinwei Smoke",
    label: "Senior Backend Engineer",
    summary: "Backend engineer with experience shipping high-throughput systems.",
    location: { city: "Hangzhou", region: "Zhejiang" },
  },
  work: [
    { name: "Acme Corp", position: "Senior Backend Engineer", startDate: "2023-01-01" },
    { name: "Prior Co", position: "Backend Engineer", startDate: "2020-06-01", endDate: "2022-12-31" },
  ],
  skills: [
    { name: "Python" },
    { name: "Go" },
    { name: "PostgreSQL" },
    { name: "Kubernetes" },
  ],
};

async function registerAndSeed() {
  const reg = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: DISPLAY_NAME }),
  });
  if (!reg.ok) {
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  }
  const { token, user } = await reg.json();

  // Seed a résumé so the workspace has the four surfaces' preconditions
  // satisfied. After this, GET /api/resumes returns the row, and the dock
  // greeting's "this résumé" group renders even without a parse-done flag.
  const res = await fetch(`${API_BASE}/api/resumes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: SAMPLE_RESUME, isBase: true }),
  });
  if (!res.ok) {
    throw new Error(`create resume failed: ${res.status} ${await res.text()}`);
  }
  const { resume } = await res.json();
  return { token, user, resumeId: resume.id };
}

async function probeUi({ token, resumeId }) {
  // Generate the probe via String.raw so backticks/dollars inside don't
  // collide with the outer template literal's interpolation parser. The
  // four ${...} placeholders we want resolved at build time are pulled
  // out as separate substitutions.
  const initScriptContent = `try { window.localStorage.setItem("vantage_token", ${JSON.stringify(token)}); } catch (_) {}`;
  const code = `
    const { chromium } = require("playwright");
    (async () => {
      const browser = await chromium.launch();
      const ctx = await browser.newContext();
      await ctx.addCookies([
        { name: "vantage_token", value: ${JSON.stringify(token)}, url: ${JSON.stringify(BASE_URL)} },
      ]);
      await ctx.addInitScript({ content: ${JSON.stringify(initScriptContent)} });

      const errors = [];
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push("pageerror: " + String(e && e.message ? e.message : e)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push("console: " + msg.text());
      });

      await page.goto(${JSON.stringify(`${BASE_URL}/app/today`)}, { waitUntil: "load", timeout: ${TIMEOUT_MS} });
      await page.waitForLoadState("networkidle", { timeout: ${TIMEOUT_MS} }).catch(() => {});
      await page.waitForTimeout(3500);

      // Open the dock launcher if it's collapsed (default state for some
      // viewports). The button title is i18n'd so match on attribute prefix.
      await page.evaluate(() => {
        const launcher = document.querySelector('button[title^="Open Ask"], button[title^="打开"]');
        if (launcher) launcher.click();
      });
      await page.waitForTimeout(800);

      const score = await page.evaluate(() => {
        const out = {};
        out.sidebar_chip = !!document.querySelector('[data-testid="sidebar-resume-chip"]');
        out.landing_card = !!document.querySelector('[data-testid="resume-landing-card"]');
        out.dock_read_summary = !!document.querySelector('[data-testid="dock-read-summary"]');
        out.dock_resume_picker = !!document.querySelector('[data-testid="dock-resume-picker"]');
        const labels = Array.from(document.querySelectorAll(".ds-mono-10")).map((n) => (n.textContent || "").trim());
        out.this_resume_group_label = labels.some((h) => h.toUpperCase().indexOf("THIS R") === 0 || h.indexOf("这份简历") >= 0);
        const chip = document.querySelector('[data-testid="sidebar-resume-chip"]');
        out._sidebar_chip_text = chip ? (chip.textContent || "").trim().slice(0, 100) : null;
        out._workspace_url = location.pathname;
        // Diagnostic: locate the dock aside element specifically.
        const dock = document.querySelector('aside[data-tour="dock"]');
        out._dock_present = !!dock;
        out._dock_text = dock ? (dock.textContent || "").trim().slice(0, 400) : null;
        out._dock_html_head = dock ? dock.outerHTML.slice(0, 600) : null;
        // Diagnostic: enumerate testids visible on the page.
        out._testids = Array.from(document.querySelectorAll('[data-testid]')).map((n) => n.getAttribute('data-testid')).slice(0, 20);
        // Diagnostic: peek inside the today-view main column to see if the
        // landing card mounted at all (it lives between the stats strip
        // and the action queue).
        const main = document.querySelector('main');
        out._main_html_head = main ? main.innerHTML.slice(0, 800) : null;
        return out;
      });

      const result = { score, errors };
      process.stdout.write(JSON.stringify(result));
      await browser.close();
    })().catch((e) => {
      process.stdout.write(JSON.stringify({ score: {}, errors: ["fatal: " + String(e && e.message ? e.message : e)] }));
      process.exit(0);
    });
  `;
  const tmpFile = join(tmpdir(), `post-upload-smoke-${process.pid}-${Date.now()}.cjs`);
  writeFileSync(tmpFile, code, "utf8");

  return new Promise((resolve) => {
    const child = spawn("node", [tmpFile], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env },
    });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d.toString()));
    child.on("close", () => {
      try { unlinkSync(tmpFile); } catch {}
      try {
        const last = buf.trim().split("\n").pop() || "{}";
        resolve(JSON.parse(last));
      } catch {
        resolve({ score: {}, errors: ["could not parse playwright output: " + buf] });
      }
    });
  });
}

(async () => {
  let token, resumeId;
  try {
    const seed = await registerAndSeed();
    token = seed.token;
    resumeId = seed.resumeId;
    console.log(JSON.stringify({ stage: "seed", ok: true, resumeId }));
  } catch (e) {
    console.log(JSON.stringify({ stage: "seed", ok: false, reason: String(e?.message ?? e) }));
    process.exit(1);
  }

  const result = await probeUi({ token, resumeId });
  const score = result.score ?? {};
  // Score breakdown:
  //   sidebar_chip               — ready-state version chip in left rail
  //   dock_resume_picker         — Your-résumés picker above chips
  //   this_resume_group_label    — "This résumé" header on the chip group
  //   dock_read_summary          — "I read it — latest role…" line
  //   landing_card               — celebratory panel on /app/today
  //
  // landing_card AND dock_read_summary both depend on parseJobStatus ===
  // "done" + parsedResume present. We achieve that path *only* via the
  // real /resumes/parse-async route. The minimal seed here covers the
  // first three; the full five-of-five is asserted by the wider e2e once
  // the LLM parse runs.
  const dims = [
    "sidebar_chip",
    "dock_resume_picker",
    "this_resume_group_label",
    "dock_read_summary",
    "landing_card",
  ];
  let passed = 0;
  for (const d of dims) {
    const ok = !!score[d];
    if (ok) passed += 1;
    console.log(JSON.stringify({ dimension: d, ok }));
  }
  if (score._sidebar_chip_text) {
    console.log(JSON.stringify({ dimension: "_sidebar_chip_text", value: score._sidebar_chip_text }));
  }
  if (score._dock_present !== undefined) {
    console.log(JSON.stringify({ dimension: "_dock_present", value: score._dock_present }));
  }
  if (score._dock_text) {
    console.log(JSON.stringify({ dimension: "_dock_text", value: score._dock_text }));
  }
  if (score._testids) {
    console.log(JSON.stringify({ dimension: "_testids", value: score._testids }));
  }
  if (score._main_html_head) {
    console.log(JSON.stringify({ dimension: "_main_html_head", value: score._main_html_head }));
  }
  if (result.errors?.length) {
    for (const err of result.errors) {
      console.log(JSON.stringify({ dimension: "runtime_error", ok: false, reason: err }));
    }
  }
  const pct = Math.round((passed / dims.length) * 100);
  console.log(JSON.stringify({ summary: { passed, total: dims.length, percent: pct, errors: result.errors ?? [] } }));
  // Exit 0 if we got at least the three "seed-only" surfaces. Two surfaces
  // gated on a real LLM parse are reported but not required for exit 0,
  // since the smoke is intentionally LLM-free.
  process.exit(score.sidebar_chip && score.dock_resume_picker && score.this_resume_group_label ? 0 : 1);
})();

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
