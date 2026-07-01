#!/usr/bin/env node
// ============================================================================
// i18n parity check — web/messages/en.json  ⇄  web/messages/zh.json
//
// Walks both locale trees and fails (exit 1) if either side is missing a key
// the other has. This is a structural guard, not a translation-quality check:
// it does NOT verify the ZH text is actually Chinese, only that every key that
// exists in one file exists in the other. That keeps a new EN string from
// shipping without its ZH counterpart (and vice versa).
//
// Arrays (landing.features.items etc.) are compared by length: a missing array
// element is a real gap the UI would render blank, so `foo.0`, `foo.1` … are
// treated as distinct leaf keys.
//
// Usage:  node scripts/check-i18n-parity.mjs
// CI:     .github/workflows/ci.yml  →  i18n-parity job
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const files = {
  en: join(repoRoot, "web/messages/en.json"),
  zh: join(repoRoot, "web/messages/zh.json"),
};

/** Flatten an object into a Set of dotted leaf paths. Arrays become indexed
 *  leaves so length mismatches surface as missing keys. */
function flatten(node, prefix, acc) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => flatten(v, `${prefix}.${i}`, acc));
    // Zero-length arrays still need a marker so an empty-vs-populated diff is
    // caught; harmless when both sides are empty.
    if (node.length === 0) acc.add(prefix);
    return acc;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      flatten(node[k], prefix ? `${prefix}.${k}` : k, acc);
    }
    return acc;
  }
  acc.add(prefix);
  return acc;
}

function load(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`✗ Failed to read/parse ${path}: ${err.message}`);
    process.exit(2);
  }
}

const en = flatten(load(files.en), "", new Set());
const zh = flatten(load(files.zh), "", new Set());

const missingInZh = [...en].filter((k) => !zh.has(k)).sort();
const missingInEn = [...zh].filter((k) => !en.has(k)).sort();

if (missingInZh.length === 0 && missingInEn.length === 0) {
  console.log(`✓ i18n parity OK — ${en.size} keys, en ⇄ zh in sync`);
  process.exit(0);
}

console.error("✗ i18n parity FAILED\n");
if (missingInZh.length) {
  console.error(`Missing in zh.json (${missingInZh.length}):`);
  for (const k of missingInZh) console.error(`  - ${k}`);
  console.error("");
}
if (missingInEn.length) {
  console.error(`Missing in en.json (${missingInEn.length}):`);
  for (const k of missingInEn) console.error(`  - ${k}`);
  console.error("");
}
console.error(
  "Every key must exist in both locales. Add the missing translations to " +
    "web/messages/{en,zh}.json and re-run.",
);
process.exit(1);
