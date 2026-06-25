// DOCX → PDF preview conversion (design §5.1 Original Pane, §7.5, P2-8).
//
// The Resume Studio's Original Pane renders the user's uploaded file with its
// real layout. PDFs go straight into an <iframe>; DOCX has no browser-native
// viewer, so we convert it to PDF once via LibreOffice headless and cache the
// result in object storage. Conversion is best-effort: when LibreOffice is not
// installed (local dev, a stripped CI image) we return null and the caller
// degrades to a download link rather than 500-ing.
//
// Caching: the converted PDF lives next to the original at
// `{...}/{file_id}.preview.pdf`. Since originals are immutable (one file_id =
// one byte stream), a cache hit is permanent — we never reconvert the same id.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Candidate LibreOffice binaries, in preference order. */
const SOFFICE_BINS = ["soffice", "libreoffice"];

let cachedBin: string | null | undefined; // undefined = not probed yet

/** Resolve a usable LibreOffice binary once, or null if none is installed. */
async function resolveSoffice(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  for (const bin of SOFFICE_BINS) {
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(bin, ["--version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    });
    if (ok) {
      cachedBin = bin;
      return bin;
    }
  }
  cachedBin = null;
  return null;
}

/** True when a converter is available — lets callers report capability. */
export async function docxPreviewAvailable(): Promise<boolean> {
  return (await resolveSoffice()) !== null;
}

/**
 * Convert DOCX bytes to PDF bytes via LibreOffice headless. Returns null when
 * no converter is installed (graceful degrade) or the conversion fails — the
 * caller then falls back to offering a download. Never throws on a missing
 * binary; only unexpected I/O errors propagate.
 */
export async function convertDocxToPdf(docx: Uint8Array): Promise<Uint8Array | null> {
  const bin = await resolveSoffice();
  if (!bin) return null;

  const dir = await mkdtemp(join(tmpdir(), "relay-docx-"));
  try {
    const inPath = join(dir, "in.docx");
    await writeFile(inPath, docx);
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(
        bin,
        ["--headless", "--convert-to", "pdf", "--outdir", dir, inPath],
        { stdio: "ignore" },
      );
      // Hard timeout so a wedged LibreOffice never hangs the request.
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        resolve(false);
      }, 20_000);
      p.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      p.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (!ok) return null;
    const pdf = await readFile(join(dir, "in.pdf")).catch(() => null);
    return pdf ? new Uint8Array(pdf) : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
