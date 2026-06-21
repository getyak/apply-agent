// Resume text extraction. Turns an uploaded file (PDF / DOCX / plain text) into
// the raw text we hand to the LLM parser. We only need text — no layout, no
// images — so the libraries stay lightweight and pure-JS (Bun-friendly):
//   - PDF  → `unpdf` (self-contained PDF.js serverless build, no native deps)
//   - DOCX → `mammoth` extractRawText (jszip + xml, no native deps)
//   - text → decoded as UTF-8 directly
//
// Both binary paths accept a Uint8Array/Buffer so nothing touches the
// filesystem. Extraction failures throw ExtractionError, which routes map to a
// 400 (a corrupt upload is a client problem, not a server fault).

/** A MIME type or extension we know how to extract text from. */
export type SupportedKind = "pdf" | "docx" | "text";

/** Thrown when a file can't be turned into text (corrupt, empty, unsupported). */
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Classify an upload by MIME type first, falling back to the filename
 * extension. Returns null for anything we don't support so the caller can
 * reject with a clear allowlist error.
 */
export function classifyKind(
  mimeType: string,
  filename: string,
): SupportedKind | null {
  const mt = mimeType.toLowerCase();
  if (mt === PDF_MIME) return "pdf";
  if (mt === DOCX_MIME) return "docx";
  if (mt.startsWith("text/")) return "text";

  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "md") return "text";
  return null;
}

// MIME1 (round-16): the round-16 file-upload audit found that
// classifyKind trusted the browser-reported MIME type + filename
// extension without ever sniffing the actual bytes. An attacker
// (or a confused copy-paste) could upload `evil.exe` renamed as
// `resume.pdf` with the right MIME and we'd happily hand it to
// unpdf. unpdf would probably fail to parse it and we'd throw, but
// a polyglot file (a valid PDF that's also a valid ZIP, for example)
// would slip past. Verify the leading bytes match the declared kind
// before we even ask the parser. Text files pass automatically — UTF-8
// has no magic bytes.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\003\004" (DOCX is a ZIP)

export function verifyMagicBytes(kind: SupportedKind, data: Uint8Array): boolean {
  if (kind === "text") return true;
  const want = kind === "pdf" ? PDF_MAGIC : ZIP_MAGIC;
  if (data.length < want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (data[i] !== want[i]) return false;
  }
  return true;
}

async function pdfToText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function docxToText(data: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return value;
}

/**
 * Extract plain text from an uploaded resume file. Normalizes whitespace and
 * guards against empty output (a scanned/image-only PDF yields no text — that's
 * a client-actionable error, not a silent empty parse).
 */
export async function extractText(
  data: Uint8Array,
  kind: SupportedKind,
): Promise<string> {
  // MIME1 (round-16): refuse to even invoke the parser when the file's
  // magic bytes don't match the declared kind. The MIME type and
  // filename extension are both client-controlled and can lie.
  if (!verifyMagicBytes(kind, data)) {
    throw new ExtractionError(
      `File contents don't match the declared ${kind} type. ` +
        "Re-save it as a real PDF / DOCX / text file and try again.",
    );
  }
  let text: string;
  try {
    if (kind === "pdf") text = await pdfToText(data);
    else if (kind === "docx") text = await docxToText(data);
    else text = new TextDecoder("utf-8").decode(data);
  } catch (err) {
    throw new ExtractionError(`Failed to extract text from ${kind} file`, err);
  }

  const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length < 20) {
    throw new ExtractionError(
      "Could not read any text from this file. If it's a scanned PDF, try " +
        "pasting the text instead.",
    );
  }
  return cleaned;
}
