// Résumé export pipeline.
//
// One canonical Markdown is the source of truth for every export format
// (docs/design/resume-original-vs-optimized-vibe-design.md §11.3). The Markdown
// itself is produced by `jsonResumeToMarkdown` — a PURE structural transform,
// zero fabrication. Everything in this module is downstream of that.
//
// Format pipeline:
//   md   → already canonical, returned verbatim.
//   json → JSON Resume, returned verbatim (the same `parsed` the client edits).
//   pdf  → Playwright Chromium headless renders the same .resume-prose CSS the
//          web preview uses (see pdf-render.ts). What the user sees = what
//          they download.
//   docx → Pandoc converts the same Markdown to DOCX (see docx-export.ts).
//          Gated by `pandocAvailable()` — returns 501 + a friendly error if
//          the binary isn't installed (export drawer surfaces this as "DOCX
//          requires a server upgrade — try PDF or Markdown").
//
// Caller (api/src/routes/resumes.ts) is responsible for ownership + auth;
// this module is pure rendering.

import type { JsonResume } from "./resume-parse";
import { jsonResumeToMarkdown } from "./resume-markdown";

export const EXPORT_FORMATS = ["md", "json", "pdf", "docx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(s: unknown): s is ExportFormat {
  return typeof s === "string" && (EXPORT_FORMATS as readonly string[]).includes(s);
}

/** MIME type for each export format — used in Content-Type headers. */
export const EXPORT_MIME: Record<ExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** File extension for Content-Disposition. */
export const EXPORT_EXT: Record<ExportFormat, string> = {
  md: "md",
  json: "json",
  pdf: "pdf",
  docx: "docx",
};

/**
 * Build a safe, readable filename for the export.
 *
 *   exportFilename(resume, "v7", "pdf") → "iris-park-resume-v7.pdf"
 *
 * Falls back to "resume" if `basics.name` is missing — never produces an
 * empty stem. ASCII only for RFC 6266 attachment filename safety across
 * browsers (callers add a UTF-8 filename* alongside if they want native).
 */
export function exportFilename(
  parsed: JsonResume,
  versionLabel: string,
  format: ExportFormat,
): string {
  const stem = slugify(parsed?.basics?.name) || "resume";
  return `${stem}-${versionLabel}.${EXPORT_EXT[format]}`;
}

function slugify(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip combining marks (accents)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Return the canonical Markdown for a parsed résumé. */
export function exportMarkdown(parsed: JsonResume): string {
  return jsonResumeToMarkdown(parsed);
}

/**
 * Return JSON Resume bytes (pretty-printed). Stable key order isn't promised
 * by Node's JSON.stringify but matches what the API serves elsewhere.
 */
export function exportJson(parsed: JsonResume): string {
  return JSON.stringify(parsed, null, 2);
}
