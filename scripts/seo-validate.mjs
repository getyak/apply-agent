#!/usr/bin/env node
// Build-time SEO + JSON-LD validator. Boots the production Next server on a
// loopback port, fetches the landing page, extracts every JSON-LD block and
// every SEO-critical <meta>/<link>, and asserts schema.org-required fields
// plus the canonical/og/twitter/hreflang/manifest set we promised to ship.
//
// Replaces "wait for Google Search Console traffic to verify rich results":
// the bits of Rich Results Test that can be checked statically (required-
// field presence, type names, FAQ Q/A pairs, Organization URL/logo/sameAs)
// are checked here at CI time. Failure exits 1 to gate deploys.
//
// Zero external deps — node built-ins only.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.SEO_VALIDATE_PORT || 3019);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("../web", import.meta.url).pathname;

const REQUIRED_META = [
  ['meta[property="og:title"]', /property="og:title"\s+content="([^"]+)"/],
  ['meta[property="og:description"]', /property="og:description"\s+content="([^"]+)"/],
  ['meta[property="og:image"]', /property="og:image"\s+content="([^"]+)"/],
  ['meta[property="og:url"]', /property="og:url"\s+content="([^"]+)"/],
  ['meta[property="og:type"]', /property="og:type"\s+content="([^"]+)"/],
  ['meta[name="twitter:card"]', /name="twitter:card"\s+content="([^"]+)"/],
  ['meta[name="twitter:image"]', /name="twitter:image"\s+content="([^"]+)"/],
  ['meta[name="description"]', /name="description"\s+content="([^"]+)"/],
  ['meta[name="theme-color"]', /name="theme-color"\s+content="([^"]+)"/],
  ['link[rel="canonical"]', /rel="canonical"\s+href="([^"]+)"/],
  ['link[rel="manifest"]', /rel="manifest"\s+href="([^"]+)"/],
  [
    'link[rel="alternate"][hreflang="x-default"]',
    /rel="alternate"\s+hrefLang="x-default"\s+href="([^"]+)"/,
  ],
];

const SCHEMA_RULES = {
  Organization: (n) => [
    !n.name && "Organization.name missing",
    !n.url && "Organization.url missing",
    !n.logo && "Organization.logo missing",
    !Array.isArray(n.sameAs) && "Organization.sameAs must be an array",
    Array.isArray(n.sameAs) &&
      n.sameAs.length === 0 &&
      "Organization.sameAs is empty (Knowledge Graph linkage)",
  ],
  WebSite: (n) => [
    !n.name && "WebSite.name missing",
    !n.url && "WebSite.url missing",
  ],
  SoftwareApplication: (n) => [
    !n.name && "SoftwareApplication.name missing",
    !n.applicationCategory && "SoftwareApplication.applicationCategory missing",
    !n.offers &&
      "SoftwareApplication.offers missing (required for rich result eligibility)",
  ],
  FAQPage: (n) => {
    const errs = [];
    if (!Array.isArray(n.mainEntity))
      errs.push("FAQPage.mainEntity must be an array");
    else if (n.mainEntity.length < 3)
      errs.push(
        `FAQPage.mainEntity has ${n.mainEntity.length} items (Google wants ≥ 3)`,
      );
    else
      for (const [i, q] of n.mainEntity.entries()) {
        if (q["@type"] !== "Question")
          errs.push(`FAQPage item ${i}: @type !== "Question"`);
        if (!q.name) errs.push(`FAQPage item ${i}: missing question text`);
        if (!q.acceptedAnswer?.text)
          errs.push(`FAQPage item ${i}: missing acceptedAnswer.text`);
      }
    return errs;
  },
};

async function get(path) {
  const res = await fetch(`${ORIGIN}${path}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.text();
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch (e) {
      out.push({ __parseError: e.message, raw: m[1].slice(0, 160) });
    }
  }
  return out;
}

function checkMeta(html) {
  const errs = [];
  for (const [label, re] of REQUIRED_META) {
    if (!re.test(html)) errs.push(`Missing ${label}`);
  }
  for (const lang of ["en", "zh-CN"]) {
    const re = new RegExp(`rel="alternate"\\s+hrefLang="${lang}"`);
    if (!re.test(html)) errs.push(`Missing hreflang="${lang}"`);
  }
  return errs;
}

function checkJsonLd(blocks) {
  const errs = [];
  const seen = new Set();
  for (const node of blocks) {
    if (node.__parseError) {
      errs.push(
        `JSON-LD parse error: ${node.__parseError} (raw=${node.raw}…)`,
      );
      continue;
    }
    const t = node["@type"];
    if (!t) {
      errs.push("JSON-LD block missing @type");
      continue;
    }
    seen.add(t);
    const rule = SCHEMA_RULES[t];
    if (rule) for (const e of rule(node)) if (e) errs.push(e);
  }
  for (const required of [
    "Organization",
    "WebSite",
    "SoftwareApplication",
    "FAQPage",
  ]) {
    if (!seen.has(required)) errs.push(`Missing JSON-LD @type=${required}`);
  }
  return errs;
}

async function checkEndpoints() {
  const errs = [];
  const endpoints = [
    ["/", "html"],
    ["/robots.txt", "plain"],
    ["/sitemap.xml", "xml"],
    ["/manifest.webmanifest", "manifest"],
    ["/opengraph-image", "png"],
    ["/apple-icon", "png"],
    ["/icon.svg", "svg"],
  ];
  for (const [path, expectFragment] of endpoints) {
    try {
      const res = await fetch(`${ORIGIN}${path}`, { redirect: "follow" });
      if (!res.ok) {
        errs.push(`${path} → ${res.status}`);
        continue;
      }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes(expectFragment)) {
        errs.push(
          `${path} → content-type "${ct}" doesn't contain "${expectFragment}"`,
        );
      }
    } catch (e) {
      errs.push(`${path} → ${e.message}`);
    }
  }
  return errs;
}

async function waitForReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${ORIGIN}/robots.txt`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`server not ready on ${ORIGIN} after 30s`);
}

async function main() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    http_proxy: "",
    https_proxy: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    all_proxy: "",
    ALL_PROXY: "",
  };
  const server = spawn("bun", ["run", "start"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let booted = false;
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  server.on("exit", (code) => {
    if (!booted) {
      console.error(`server exited early with code ${code}`);
      process.exit(2);
    }
  });

  try {
    await waitForReady();
    booted = true;

    const html = await get("/");
    const blocks = extractJsonLd(html);
    const errs = [
      ...checkMeta(html),
      ...checkJsonLd(blocks),
      ...(await checkEndpoints()),
    ];

    console.log(`\nJSON-LD blocks found: ${blocks.length}`);
    for (const b of blocks) {
      if (b.__parseError) console.log(`  - <parse error>`);
      else console.log(`  - @type=${b["@type"]}`);
    }

    if (errs.length) {
      console.error(`\n❌ ${errs.length} SEO problem(s):`);
      for (const e of errs) console.error(`  - ${e}`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ All SEO + JSON-LD checks passed.`);
    }
  } finally {
    server.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
