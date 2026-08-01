// Résumé Markdown → passive HTML → deterministic ATS DOCX via Pandoc.
//
// Pandoc produces a proper Word document with native heading styles, bullet
// lists, and runs. Relay sanitizes Markdown into a shared passive HTML
// contract first, then adds a versioned reference DOCX so page geometry and
// typography never fall back to Pandoc/Word defaults.
//
// Why stdin/stdout instead of temp files (as docx-preview.ts uses for
// soffice): Pandoc supports stream conversion, so the HTML stdin → DOCX
// stdout pipe avoids filesystem cleanup.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  type ResumeArtifactAudit,
  type ResumeArtifactProfile,
  resolveResumeArtifactProfile,
} from "./resume-artifact-profile";
import { markdownToSafeArtifactHtml } from "./resume-artifact-markdown";

const PANDOC_BIN = "pandoc";

let cachedAvailable: boolean | undefined; // undefined = not probed

async function probePandoc(): Promise<boolean> {
  if (cachedAvailable !== undefined) return cachedAvailable;
  cachedAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn(PANDOC_BIN, ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
  return cachedAvailable;
}

/** True when Pandoc is installed — lets callers report capability. */
export async function docxExportAvailable(): Promise<boolean> {
  if (!(await probePandoc())) return false;
  try {
    await stat(referenceDocPath("one_page"));
    await stat(referenceDocPath("two_page"));
    return true;
  } catch {
    return false;
  }
}

function referenceDocPath(lengthBudget: "one_page" | "two_page"): string {
  return join(
    fileURLToPath(new URL("../assets", import.meta.url)),
    `resume-reference-${lengthBudget}.docx`,
  );
}

export interface RenderedResumeDocx {
  bytes: Uint8Array;
  audit: ResumeArtifactAudit;
}

const DOCX_ARCHIVE_TIME = new Date("2025-01-01T00:00:00Z");

/**
 * Pandoc emits the legacy Symbol-font private-use glyph U+F0B7 for level-zero
 * bullets. Word maps it correctly, but Pages and macOS Office Quick Look can
 * display only the indentation. Normalize the package to a standard Unicode
 * bullet while retaining native OOXML numbering semantics.
 */
export function normalizeDocxListFormatting(docx: Uint8Array): Uint8Array {
  const files = unzipSync(docx);
  const numbering = files["word/numbering.xml"];
  if (!numbering) return docx;

  const normalized = strFromU8(numbering)
    .replaceAll("\uf0b7", "•")
    .replaceAll('w:ascii="Symbol"', 'w:ascii="Arial"')
    .replaceAll('w:hAnsi="Symbol"', 'w:hAnsi="Arial"')
    .replaceAll('w:cs="Symbol"', 'w:cs="Arial"')
    .replace(
      /<w:ind w:left="720" w:hanging="360"\s*\/>/g,
      '<w:ind w:left="272" w:hanging="125" />',
    );
  files["word/numbering.xml"] = strToU8(normalized);
  return zipSync(files, { level: 9, mtime: DOCX_ARCHIVE_TIME });
}

/**
 * Convert canonical Markdown to DOCX bytes via Pandoc. Returns null when
 * Pandoc isn't installed (graceful degrade) or the conversion fails — the
 * caller then returns 501 with a friendly message rather than 500-ing.
 * Never throws on a missing binary; only unexpected I/O errors propagate.
 *
 * Hard timeout: 20s. A wedged Pandoc never hangs the request.
 */
export async function renderResumeDocx(
  markdown: string,
  profile: ResumeArtifactProfile = resolveResumeArtifactProfile({}),
): Promise<RenderedResumeDocx | null> {
  if (!(await docxExportAvailable())) return null;

  return new Promise<RenderedResumeDocx | null>((resolve) => {
    // -t docx + -o -  → write DOCX bytes to stdout instead of a temp file.
    // --standalone keeps Word's "this is a document" framing intact.
    const p = spawn(
      PANDOC_BIN,
      [
        "-f",
        "html",
        "-t",
        "docx",
        "--standalone",
        "--wrap=none",
        `--reference-doc=${referenceDocPath(profile.lengthBudget)}`,
        `--metadata=lang:${profile.artifactLocale}`,
        "-o",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let errBuf = "";
    let done = false;

    const finish = (result: RenderedResumeDocx | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish(null);
    }, 20_000);

    p.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    p.stderr.on("data", (chunk: Buffer) => {
      // Keep a short prefix so unexpected failures are debuggable from logs
      // without buffering megabytes of Pandoc chatter.
      if (errBuf.length < 1024) errBuf += chunk.toString("utf-8");
    });
    p.on("error", () => finish(null));
    p.on("exit", (code) => {
      if (code === 0 && chunks.length > 0) {
        finish({
          bytes: normalizeDocxListFormatting(
            new Uint8Array(Buffer.concat(chunks)),
          ),
          audit: {
            rendererVersion: profile.rendererVersion,
            format: "docx",
            artifactLocale: profile.artifactLocale,
            lengthBudget: profile.lengthBudget,
            atsProfile: profile.atsProfile,
            targetPages: profile.targetPages,
            pageCount: null,
            withinBudget: null,
          },
        });
      } else {
        if (errBuf) console.warn(`[docx-export] pandoc failed: ${errBuf.trim()}`);
        finish(null);
      }
    });

    // Both file renderers consume the same passive HTML contract.
    p.stdin.end(markdownToSafeArtifactHtml(markdown), "utf-8");
  });
}
