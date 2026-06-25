import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { largeBodySizeLimit } from "../middleware/security";
import { storage, StorageUnavailableError } from "../storage";
import { classifyKind, ExtractionError } from "../extract";
import { convertDocxToPdf } from "../docx-preview";
import { bytesToMarkdown } from "../markdown";
import { ValidationError, UpstreamError } from "../errors";
import { requireOwnership } from "../ownership";
import type { AppEnv } from "../types";

// File upload API (API-019). Accepts a multipart resume upload, stores the
// original blob in object storage (MinIO/S3), persists a row in user_files, and
// — for resume uploads — returns the extracted text so the client can hand it
// straight to /api/resumes/parse without a second round-trip.
//
// Security:
//   - Extension + MIME allowlist (PDF/DOCX/text only).
//   - Hard size cap (the global bodySizeLimit also guards, this is belt+braces).
//   - Storage key is built from the server-owned userId + a fresh uuid, never
//     from the client filename — no path traversal across users.

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — resumes are small; reject the rest.

const EXT_BY_KIND: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  text: "txt",
};

// POST /api/files — multipart upload of a single resume file.
//   form fields: file (required)
//
// FILES_SIZE1 (round-18): the global `bodySizeLimit` in `index.ts`
// caps everything at 1 MiB (round-7 SEC1 reasoning was "JSON bodies
// are small"). That cap fired before this route's 8 MiB `MAX_BYTES`,
// so a 50-page PDF (≈ 2.5 MiB — within the round-17 MAX_PDF_PAGES
// cap) got 413'd at the gateway. Apply the larger ceiling on this
// single route so multi-page résumés actually make it to the parser.
// The per-file `MAX_BYTES` check below still applies as the second
// fence; this just unblocks the route.
app.post("/", largeBodySizeLimit, async (c) => {
  const userId = c.get("userId");

  const form = await c.req.formData().catch(() => {
    throw new ValidationError(
      "Expected multipart/form-data with a 'file' field",
    );
  });
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError("Missing 'file' field");
  }

  const kind = classifyKind(file.type || "", file.name || "");
  if (!kind) {
    throw new ValidationError(
      "Unsupported file type. Upload a PDF, DOCX, or plain-text resume.",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ValidationError("File is empty");
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new ValidationError(
      `File exceeds the ${MAX_BYTES / 1024 / 1024} MB limit`,
    );
  }

  // Convert to the Markdown middle state first: a corrupt/scanned file is a
  // client problem we want to surface as 400 BEFORE we persist anything. The
  // Markdown is the canonical artifact the parser consumes; `text` is derived
  // from it for backward compatibility with the synchronous parse path.
  let markdown: string;
  try {
    const md = await bytesToMarkdown(bytes, kind);
    markdown = md.markdown;
  } catch (err) {
    if (err instanceof ExtractionError) {
      throw new ValidationError(err.message);
    }
    throw err;
  }
  const text = markdown;

  // Persist original to object storage, then record metadata. If storage is
  // unconfigured (CI/local-without-MinIO) we still return the extracted text so
  // the parse flow works — we just don't keep the original blob.
  const fileId = crypto.randomUUID();
  const ext = EXT_BY_KIND[kind];
  const storageKey = `${userId}/resumes/originals/${fileId}.${ext}`;
  const contentType = file.type || "application/octet-stream";

  let stored = false;
  if (storage.available) {
    try {
      await storage.put(storageKey, bytes, contentType);
      stored = true;
    } catch (err) {
      if (!(err instanceof StorageUnavailableError)) {
        throw new UpstreamError("File storage failed", (err as Error).message);
      }
      // StorageUnavailableError → degrade: proceed without the stored original.
    }
  }

  if (stored) {
    const checksum = Buffer.from(
      await crypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    await query(
      `INSERT INTO user_files
         (id, user_id, path, filename, storage_key, mime_type, size_bytes,
          checksum_sha256, file_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'resume_original', NOW())`,
      [
        fileId,
        userId,
        storageKey, // path == storage_key keeps UNIQUE(user_id, path) happy
        file.name || `resume.${ext}`,
        storageKey,
        contentType,
        bytes.byteLength,
        checksum,
      ],
    );
  }

  return c.json(
    {
      file: stored
        ? { id: fileId, filename: file.name, sizeBytes: bytes.byteLength, kind }
        : null,
      stored,
      // Markdown is the canonical middle state for the onboarding parse step;
      // `text` mirrors it so the existing synchronous /parse path still works.
      markdown,
      text,
      kind,
    },
    201,
  );
});

// Generic chat attachment upload. Unlike POST / (resume-only — it runs the
// file through the résumé Markdown extractor and 400s anything that isn't a
// PDF/DOCX/TXT résumé), this route just persists the blob and returns a
// reference. It accepts the résumé doc types *and* common image formats so a
// user can drop a screenshot / portfolio image into the chat composer.
//
// Security mirrors POST /:
//   - Extension + MIME allowlist (no executables, no arbitrary types).
//   - Hard size cap (largeBodySizeLimit gateway fence + ATTACH_MAX_BYTES here).
//   - Storage key derived from server-owned userId + fresh uuid (no traversal).
const ATTACH_MAX_BYTES = 8 * 1024 * 1024; // 8 MB — same ceiling as résumés.

// MIME → extension allowlist. Keys are the canonical content types; we also
// fall back to the filename extension when the browser reports a generic type.
const ATTACH_TYPES: Record<string, { ext: string; kind: string }> = {
  "application/pdf": { ext: "pdf", kind: "pdf" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    ext: "docx",
    kind: "docx",
  },
  "text/plain": { ext: "txt", kind: "text" },
  "text/markdown": { ext: "md", kind: "text" },
  "image/png": { ext: "png", kind: "image" },
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
};

const ATTACH_EXT: Record<string, { ext: string; kind: string }> = {
  pdf: { ext: "pdf", kind: "pdf" },
  docx: { ext: "docx", kind: "docx" },
  txt: { ext: "txt", kind: "text" },
  md: { ext: "md", kind: "text" },
  png: { ext: "png", kind: "image" },
  jpg: { ext: "jpg", kind: "image" },
  jpeg: { ext: "jpg", kind: "image" },
  webp: { ext: "webp", kind: "image" },
  gif: { ext: "gif", kind: "image" },
};

function classifyAttachment(
  mime: string,
  filename: string,
): { ext: string; kind: string } | null {
  const byMime = ATTACH_TYPES[mime.toLowerCase()];
  if (byMime) return byMime;
  const dot = filename.lastIndexOf(".");
  if (dot >= 0) {
    const ext = filename.slice(dot + 1).toLowerCase();
    const byExt = ATTACH_EXT[ext];
    if (byExt) return byExt;
  }
  return null;
}

// POST /api/files/attachment — multipart upload of a single chat attachment.
//   form fields: file (required)
app.post("/attachment", largeBodySizeLimit, async (c) => {
  const userId = c.get("userId");

  const form = await c.req.formData().catch(() => {
    throw new ValidationError(
      "Expected multipart/form-data with a 'file' field",
    );
  });
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError("Missing 'file' field");
  }

  const spec = classifyAttachment(file.type || "", file.name || "");
  if (!spec) {
    throw new ValidationError(
      "Unsupported file type. Upload a PDF, DOCX, TXT, or image (PNG/JPG/WEBP/GIF).",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ValidationError("File is empty");
  }
  if (bytes.byteLength > ATTACH_MAX_BYTES) {
    throw new ValidationError(
      `File exceeds the ${ATTACH_MAX_BYTES / 1024 / 1024} MB limit`,
    );
  }

  // Storage is required for attachments — there's no extracted-text fallback
  // like the résumé path has, so a missing blob means the reference is useless.
  if (!storage.available) {
    throw new UpstreamError("File storage is not configured");
  }

  const fileId = crypto.randomUUID();
  const storageKey = `${userId}/attachments/${fileId}.${spec.ext}`;
  const contentType = file.type || "application/octet-stream";

  try {
    await storage.put(storageKey, bytes, contentType);
  } catch (err) {
    if (err instanceof StorageUnavailableError) {
      throw new UpstreamError("File storage is not configured");
    }
    throw new UpstreamError("File storage failed", (err as Error).message);
  }

  const checksum = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  await query(
    `INSERT INTO user_files
       (id, user_id, path, filename, storage_key, mime_type, size_bytes,
        checksum_sha256, file_type, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'attachment', NOW())`,
    [
      fileId,
      userId,
      storageKey,
      file.name || `attachment.${spec.ext}`,
      storageKey,
      contentType,
      bytes.byteLength,
      checksum,
    ],
  );

  return c.json(
    {
      file: {
        id: fileId,
        filename: file.name || `attachment.${spec.ext}`,
        sizeBytes: bytes.byteLength,
        kind: spec.kind,
      },
      stored: true,
      kind: spec.kind,
    },
    201,
  );
});

// GET /api/files/:id/download — presigned URL for the stored original (API-020
// seed). Ownership-checked; 404 for non-owners (enumeration-safe).
app.get("/:id/download", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const row = await requireOwnership(
    "user_files",
    id,
    userId,
    "storage_key, is_deleted",
  );
  if (row.is_deleted) {
    throw new ValidationError("File has been deleted");
  }
  const url = storage.presign(row.storage_key as string);
  if (!url) {
    throw new UpstreamError("File storage is not configured");
  }
  return c.json({ url });
});

// GET /:id/preview — an INLINE-renderable URL for the Resume Studio Original
// Pane (design §5.1). PDFs return an inline presigned URL directly. DOCX is
// converted to PDF once (LibreOffice headless), cached next to the original as
// `{key}.preview.pdf`, then served inline. When no converter is available the
// response degrades to `{ available: false }` and the client shows a download
// fallback — never a 500 (design §7.5).
app.get("/:id/preview", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const row = await requireOwnership(
    "user_files",
    id,
    userId,
    "storage_key, mime_type, filename, is_deleted",
  );
  if (row.is_deleted) {
    throw new ValidationError("File has been deleted");
  }
  const storageKey = row.storage_key as string;
  const mime = (row.mime_type as string) ?? "";
  const filename = ((row.filename as string) ?? "").toLowerCase();
  const kind = classifyKind(mime, filename);

  // PDF: inline straight from the original. (Trusted, non-executable type —
  // see the `inline` note on storage.presign.)
  if (kind === "pdf") {
    const url = storage.presign(storageKey, 300, "inline");
    if (!url) throw new UpstreamError("File storage is not configured");
    return c.json({ available: true, kind: "pdf", url });
  }

  // DOCX: serve a cached converted PDF, converting on first request.
  if (kind === "docx") {
    const previewKey = `${storageKey}.preview.pdf`;
    // Cache hit? presign the existing converted PDF.
    let cached = false;
    try {
      await storage.get(previewKey);
      cached = true;
    } catch {
      cached = false;
    }
    if (!cached) {
      try {
        const original = await storage.get(storageKey);
        const pdf = await convertDocxToPdf(original);
        if (!pdf) {
          // No converter / conversion failed → degrade to download.
          return c.json({ available: false, kind: "docx" });
        }
        await storage.put(previewKey, pdf, "application/pdf");
      } catch {
        return c.json({ available: false, kind: "docx" });
      }
    }
    const url = storage.presign(previewKey, 300, "inline");
    if (!url) throw new UpstreamError("File storage is not configured");
    return c.json({ available: true, kind: "docx", url });
  }

  // text / markdown / unknown — the Original Pane renders these client-side
  // from the stored raw text, so there's nothing to preview here.
  return c.json({ available: false, kind });
});

export default app;
