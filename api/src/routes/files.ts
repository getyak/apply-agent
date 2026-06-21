import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { largeBodySizeLimit } from "../middleware/security";
import { storage, StorageUnavailableError } from "../storage";
import { classifyKind, ExtractionError } from "../extract";
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

export default app;
