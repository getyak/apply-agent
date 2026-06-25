// Résumé Markdown → DOCX conversion via Pandoc.
//
// Pandoc is the right tool for "Markdown → real DOCX": it produces a proper
// Word document with native heading styles, bullet lists, and runs that Word
// can re-style — not an HTML-pretending-to-be-Word file that breaks the
// moment a recruiter opens it. The trade-off: Pandoc must be installed on
// the host. We probe once, cache the result, and gracefully return null when
// it isn't available — the export endpoint then surfaces a friendly "DOCX
// requires a server upgrade — try PDF or Markdown" message.
//
// Why stdin/stdout instead of temp files (as docx-preview.ts uses for
// soffice): Pandoc is designed around stream conversion, so a stdin → stdout
// pipe avoids touching the filesystem entirely. Faster, no /tmp cleanup
// needed, simpler.

import { spawn } from "node:child_process";

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
  return probePandoc();
}

/**
 * Convert canonical Markdown to DOCX bytes via Pandoc. Returns null when
 * Pandoc isn't installed (graceful degrade) or the conversion fails — the
 * caller then returns 501 with a friendly message rather than 500-ing.
 * Never throws on a missing binary; only unexpected I/O errors propagate.
 *
 * Hard timeout: 20s. A wedged Pandoc never hangs the request.
 */
export async function renderResumeDocx(markdown: string): Promise<Uint8Array | null> {
  if (!(await probePandoc())) return null;

  return new Promise<Uint8Array | null>((resolve) => {
    // -t docx + -o -  → write DOCX bytes to stdout instead of a temp file.
    // --standalone keeps Word's "this is a document" framing intact.
    const p = spawn(
      PANDOC_BIN,
      ["-f", "markdown+smart", "-t", "docx", "--standalone", "-o", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let errBuf = "";
    let done = false;

    const finish = (result: Uint8Array | null) => {
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
        finish(new Uint8Array(Buffer.concat(chunks)));
      } else {
        if (errBuf) console.warn(`[docx-export] pandoc failed: ${errBuf.trim()}`);
        finish(null);
      }
    });

    // Write Markdown then close stdin so Pandoc starts processing.
    p.stdin.end(markdown, "utf-8");
  });
}
