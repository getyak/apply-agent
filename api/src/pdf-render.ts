// Résumé → deterministic ATS PDF rendering pipeline.
//
// Pipeline: canonical Markdown → safe Marked HTML → profile CSS → Chromium PDF
// → parsed page-count audit. The interactive studio remains spacious; file
// export uses a compact, closed renderer profile so one_page/two_page means the
// same thing on every request.
//
// Browser lifecycle: one shared Chromium instance, lazily launched, auto-
// closes after 60 seconds of idle to release ~300MB RAM. Each request gets
// its own context so cookies/localStorage from one user can't leak to another.
//
// Failure mode: if Chromium isn't installed (e.g. the docker image hasn't
// run `playwright install chromium`), launch() throws "Executable doesn't
// exist". The export endpoint catches this and returns 501 + a friendly
// "PDF requires a server upgrade" message.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocumentProxy } from "unpdf";
import {
  chromium,
  type Browser,
  type BrowserContext,
} from "playwright";
import {
  type ResumeArtifactAudit,
  type ResumeArtifactProfile,
  resolveResumeArtifactProfile,
} from "./resume-artifact-profile";
import { markdownToSafeArtifactHtml } from "./resume-artifact-markdown";

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
    }).catch((error) => {
      browserPromise = null;
      throw error;
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

// Dedicated file-export CSS. Read once at startup so requests do no disk churn.
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

function profileCss(profile: ResumeArtifactProfile): string {
  const type = profile.typography;
  return [
    ":root{",
    `--artifact-margin-top:${profile.page.marginTopMm}mm;`,
    `--artifact-margin-right:${profile.page.marginRightMm}mm;`,
    `--artifact-margin-bottom:${profile.page.marginBottomMm}mm;`,
    `--artifact-margin-left:${profile.page.marginLeftMm}mm;`,
    `--artifact-body-size:${type.bodySizePt}pt;`,
    `--artifact-body-line-height:${type.bodyLineHeight};`,
    `--artifact-name-size:${type.nameSizePt}pt;`,
    `--artifact-section-size:${type.sectionSizePt}pt;`,
    `--artifact-role-size:${type.roleSizePt}pt;`,
    `--artifact-bullet-indent:${type.bulletIndentMm}mm;`,
    `--artifact-section-before:${type.sectionBeforeMm}mm;`,
    `--artifact-paragraph-after:${type.paragraphAfterMm}mm;`,
    `--artifact-bullet-after:${type.bulletAfterMm}mm;`,
    "}",
  ].join("");
}

export interface RenderedResumePdf {
  bytes: Buffer;
  audit: ResumeArtifactAudit;
}

/**
 * Render a résumé Markdown document to a PDF byte stream.
 *
 * Returns bytes plus an actual parsed page-count audit. Turning the bytes back
 * into a stream just to hand them to Hono adds complexity with no memory win.
 *
 * Errors propagate as-is so the caller can map "browser not installed" to a
 * 501, and any rendering error to a 500.
 */
export async function renderResumePdf(
  markdown: string,
  profile: ResumeArtifactProfile = resolveResumeArtifactProfile({}),
): Promise<RenderedResumePdf> {
  const html = buildPrintHtml(
    markdownToSafeArtifactHtml(markdown),
    await loadCss(),
    profile,
  );

  const browser = await getBrowser();
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
    });
    const bytes = Buffer.from(pdf);
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const pageCount = document.numPages;
    await document.destroy();
    return {
      bytes,
      audit: {
        rendererVersion: profile.rendererVersion,
        format: "pdf",
        artifactLocale: profile.artifactLocale,
        lengthBudget: profile.lengthBudget,
        atsProfile: profile.atsProfile,
        targetPages: profile.targetPages,
        pageCount,
        withinBudget: pageCount <= profile.targetPages,
      },
    };
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
function buildPrintHtml(
  bodyHtml: string,
  css: string,
  profile: ResumeArtifactProfile,
): string {
  return [
    "<!doctype html>",
    `<html lang="${profile.artifactLocale}">`,
    "<head>",
    '<meta charset="utf-8">',
    "<title>Résumé</title>",
    "<style>",
    profileCss(profile),
    css,
    "</style>",
    "</head>",
    `<body><div class="resume-prose" data-length-budget="${profile.lengthBudget}">`,
    bodyHtml,
    "</div></body>",
    "</html>",
  ].join("\n");
}

/**
 * Probe whether Chromium can actually launch. Playwright may install only its
 * headless shell to save image space; in that configuration executablePath()
 * can still point at the intentionally absent full browser even though a
 * normal headless launch succeeds. Reuse the shared browser so a successful
 * capability check adds no second process to the export request.
 */
export async function pdfRenderAvailable(): Promise<boolean> {
  try {
    await getBrowser();
    bumpIdleTimer();
    return true;
  } catch {
    return false;
  }
}

/** Close the shared browser immediately for tests and one-shot CLI scripts. */
export async function closePdfRenderer(): Promise<void> {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  const pendingBrowser = browserPromise;
  browserPromise = null;
  if (pendingBrowser) {
    await pendingBrowser.then((browser) => browser.close()).catch(() => {});
  }
}
