// Markdown intermediate representation. Every uploaded resume — whatever its
// original format — is normalized to structured Markdown BEFORE it reaches the
// LLM parser. Markdown is the canonical middle state of the resume pipeline:
//   upload → extract → **markdown** → JSON Resume
//
// Why a Markdown middle state (not raw text)?
//   - Headings (## EXPERIENCE), bullets (- ...), and emphasis (**bold**) survive
//     the conversion, so the LLM sees document structure instead of a flattened
//     blob → more accurate, more stable parsing.
//   - One Markdown artifact is reusable: parse to JSON Resume, embed, feed the
//     résumé builder, or export. "Convert once, map to many" (the data-spine
//     principle from the vision doc).
//
// Layered strategy (deliberately restrained — no torch/GPU/native deps):
//   L0 (default, pure-JS, Bun-friendly, zero cost):
//     - DOCX → mammoth.convertToHtml → turndown   (real heading/list structure)
//     - PDF  → unpdf text + line heuristics        (bullets + paragraphs)
//     - text → passed through as-is (already markdown-ish)
//   L1 (optional, pluggable, OFF by default):
//     - a provider (LlamaParse cloud / self-hosted Docling over HTTP) for
//       complex multi-column / table layouts. Always falls back to L0 on
//       failure — never silently swallows the error.

import TurndownService from "turndown";
import { classifyKind, ExtractionError, type SupportedKind } from "./extract";
import { config } from "./config";

export type { SupportedKind };
export { classifyKind, ExtractionError };

/** Which layer actually produced the Markdown. */
export type MarkdownTier = "L0" | "L1";

export interface MarkdownResult {
  /** Structured Markdown — the canonical resume middle state. */
  markdown: string;
  /** The layer that produced this result (L1 → L0 fallback reports "L0"). */
  tier: MarkdownTier;
  /** Provider name when an L1 provider was used. */
  provider?: string;
  /** Non-fatal warnings (mammoth messages, heuristic uncertainty, fallback). */
  warnings?: string[];
  /** True when L1 was requested but we fell back to L0. */
  degraded?: boolean;
}

/**
 * An optional L1 provider. Providers are pluggable and OFF by default; each one
 * talks HTTP (the TS API layer cannot import Python libraries — Docling/MarkItDown
 * live behind the FastAPI agent service; LlamaParse/Reducto are cloud APIs).
 * A provider must THROW on failure so the orchestrator can fall back to L0.
 */
export interface MarkdownProvider {
  readonly name: string;
  toMarkdown(
    data: Uint8Array,
    kind: SupportedKind,
    opts?: { timeoutMs?: number },
  ): Promise<string>;
}

// turndown is configured once; ATX headings (`## x`) and `-` bullets match the
// shape the parser prompt expects. Bun resolves the Node entry, which bundles
// the pure-JS DOM (no native deps).
const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

async function docxToMarkdown(
  data: Uint8Array,
): Promise<{ markdown: string; warnings: string[] }> {
  const mammoth = (await import("mammoth")).default;
  // convertToHtml (not extractRawText) preserves Word's *semantic* structure:
  // Heading styles → <h1..6>, lists → <ul>/<ol>, bold → <strong>.
  const { value: html, messages } = await mammoth.convertToHtml({
    buffer: Buffer.from(data),
  });
  const markdown = turndown.turndown(html);
  const warnings = messages
    .filter((m) => m.type === "warning" || m.type === "error")
    .map((m) => m.message);
  return { markdown, warnings };
}

// Common bullet glyphs that PDFs emit at the start of a list item.
const BULLET_GLYPHS = /^[•·‣◦⁃∙▪●*–—]\s+/;
// A short, terminal-punctuation-free, mostly-uppercase line reads as a heading
// (e.g. "EXPERIENCE", "EDUCATION"). Conservative — when unsure, leave it prose.
const LIKELY_HEADING = /^[A-Z][A-Z0-9 &/]{2,40}$/;

/**
 * PDF → Markdown without layout analysis. unpdf gives us text only (no semantic
 * headings exist in PDF), so we apply cheap line heuristics: turn bullet glyphs
 * into `-`, promote ALL-CAPS section labels to `##`, and collapse runaway blank
 * lines. Complex two-column / table layouts are explicitly out of L0 scope —
 * that's what an L1 provider is for.
 */
export function textToMarkdownHeuristic(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      out.push("");
      continue;
    }
    if (BULLET_GLYPHS.test(trimmed)) {
      out.push(`- ${trimmed.replace(BULLET_GLYPHS, "")}`);
      continue;
    }
    if (LIKELY_HEADING.test(trimmed)) {
      out.push(`## ${trimmed}`);
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfToMarkdown(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return textToMarkdownHeuristic(text);
}

/** L0: pure-JS conversion. Always available, always the fallback floor. */
async function toMarkdownL0(
  data: Uint8Array,
  kind: SupportedKind,
): Promise<MarkdownResult> {
  let markdown: string;
  const warnings: string[] = [];
  try {
    if (kind === "docx") {
      const r = await docxToMarkdown(data);
      markdown = r.markdown;
      warnings.push(...r.warnings);
    } else if (kind === "pdf") {
      markdown = await pdfToMarkdown(data);
    } else {
      // Plain text / .md: already close to Markdown; just normalize newlines.
      markdown = new TextDecoder("utf-8")
        .decode(data)
        .replace(/\r\n/g, "\n")
        .trim();
    }
  } catch (err) {
    throw new ExtractionError(`Failed to convert ${kind} to Markdown`, err);
  }

  const cleaned = markdown.replace(/\n{3,}/g, "\n\n").trim();
  // A scanned/image-only PDF yields ~nothing — that's a client-actionable error,
  // not a silent empty parse. Strip markdown punctuation before measuring so a
  // page of just "## " noise still counts as empty.
  if (cleaned.replace(/[#\-*\s]/g, "").length < 20) {
    throw new ExtractionError(
      "Could not read any text from this file. If it's a scanned PDF, try " +
        "pasting the text instead.",
    );
  }
  return { markdown: cleaned, tier: "L0", ...(warnings.length ? { warnings } : {}) };
}

/** Registry of optional L1 providers, keyed by config.MARKDOWN_PROVIDER. */
const providers: Record<string, MarkdownProvider> = {};

/** Register an L1 provider (called at boot when a provider is configured). */
export function registerMarkdownProvider(p: MarkdownProvider): void {
  providers[p.name] = p;
}

/**
 * Convert an uploaded file's bytes into structured Markdown. L0 always runs and
 * is the floor; if an L1 provider is configured AND enabled it's attempted, and
 * any failure transparently falls back to L0 with a `degraded` flag + warning.
 */
export async function bytesToMarkdown(
  data: Uint8Array,
  kind: SupportedKind,
): Promise<MarkdownResult> {
  const l0 = await toMarkdownL0(data, kind);

  const providerName = config.MARKDOWN_PROVIDER;
  if (providerName === "off") return l0;
  const provider = providers[providerName];
  if (!provider) return l0;

  try {
    const markdown = await provider.toMarkdown(data, kind, { timeoutMs: 30_000 });
    if (markdown.trim().length < 20) return l0; // empty L1 → trust L0
    return { markdown: markdown.trim(), tier: "L1", provider: provider.name };
  } catch (err) {
    return {
      ...l0,
      degraded: true,
      warnings: [
        ...(l0.warnings ?? []),
        `L1 provider "${provider.name}" failed, fell back to L0: ${(err as Error).message}`,
      ],
    };
  }
}
