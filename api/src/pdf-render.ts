// Résumé → PDF rendering pipeline.
//
// Pipeline: canonical Markdown → marked (HTML) → Playwright Chromium → PDF.
// The CSS injected at render time is a verbatim copy of the web app's
// .resume-prose theme (api/src/resume-print.css ← web/src/components/studio/
// resume-markdown.css), so "what the user sees in the browser preview" ===
// "what comes out of the PDF". That equivalence is the contract — when the
// CSS changes, this file's copy must change too. (Future: serve the CSS file
// over a build step instead of copying. For now the copy is small and stable.)
//
// Browser lifecycle: one shared Chromium instance, lazily launched, auto-
// closes after 60 seconds of idle to release ~300MB RAM. Each request gets
// its own context so cookies/localStorage from one user can't leak to another.
//
// Failure mode: if Chromium isn't installed (e.g. the docker image hasn't
// run `playwright install chromium`), launch() throws "Executable doesn't
// exist". The export endpoint catches this and returns 501 + a friendly
// "PDF requires a server upgrade" message.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import {
  chromium,
  type Browser,
  type BrowserContext,
} from "playwright";

const IDLE_SHUTDOWN_MS = 60_000;

// One shared, lazily-launched browser. The pool is intentionally a singleton:
// PDF rendering is bursty, contexts are cheap, full browser processes are not.
let browserPromise: Promise<Browser> | null = null;
let shutdownTimer: NodeJS.Timeout | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    });
  }
  return browserPromise;
}

function bumpIdleTimer(): void {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    const p = browserPromise;
    browserPromise = null;
    shutdownTimer = null;
    p?.then((b) => b.close()).catch(() => {
      /* shutdown best-effort; container restart will clean up if needed */
    });
  }, IDLE_SHUTDOWN_MS);
  shutdownTimer.unref?.();
}

// Module-scope CSS load. resume-print.css is a verbatim copy of the web app's
// .resume-prose theme — see the file's own header. Read once at startup, kept
// in memory (~12 KB) so we don't hit the disk per request.
let cssPromise: Promise<string> | null = null;
async function loadCss(): Promise<string> {
  if (!cssPromise) {
    cssPromise = readFile(
      join(fileURLToPath(new URL(".", import.meta.url)), "resume-print.css"),
      "utf-8",
    );
  }
  return cssPromise;
}

function renderMarkdown(md: string): string {
  const marked = new Marked({ gfm: true, breaks: false });
  return marked.parse(md, { async: false }) as string;
}

/**
 * Render a résumé Markdown document to a PDF byte stream.
 *
 * Returns a Buffer rather than a stream because `page.pdf()` returns a
 * Buffer — turning it back into a stream just to hand it to Hono adds
 * complexity with no memory win (PDFs are well under 1 MB for a résumé).
 *
 * Errors propagate as-is so the caller can map "browser not installed" to a
 * 501, and any rendering error to a 500.
 */
export async function renderResumePdf(markdown: string): Promise<Buffer> {
  const html = buildPrintHtml(renderMarkdown(markdown), await loadCss());

  const browser = await getBrowser();
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    // `domcontentloaded` is enough — we inject all CSS inline and load no
    // external scripts or fonts. Waiting for `load` would block on Google
    // Fonts the offline stylesheet doesn't try to fetch anyway.
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "14mm", right: "14mm" },
      preferCSSPageSize: false,
    });
    return pdf;
  } finally {
    await context?.close().catch(() => {});
    bumpIdleTimer();
  }
}

/**
 * Compose the printable HTML document. The .resume-prose class is what binds
 * the CSS to the markdown body — mirrors web/src/components/studio/
 * resume-markdown.tsx wrapping its body in <div className="resume-prose">.
 */
function buildPrintHtml(bodyHtml: string, css: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Résumé</title>",
    "<style>",
    css,
    "html,body{margin:0;padding:0;background:#fff;}",
    ".resume-prose{margin:0 auto;max-width:none;}",
    "</style>",
    "</head>",
    '<body><div class="resume-prose">',
    bodyHtml,
    "</div></body>",
    "</html>",
  ].join("\n");
}

/**
 * Probe whether Chromium is installed. Cheap — checks the executable path
 * exists, launches nothing. Used by the export endpoint to decide between
 * 200 (render) and 501 (graceful "PDF not available" message).
 */
export async function pdfRenderAvailable(): Promise<boolean> {
  try {
    const path = chromium.executablePath();
    if (!path) return false;
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
