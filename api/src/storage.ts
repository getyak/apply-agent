import { S3Client } from "bun";
import { config } from "./config";

// Object-storage client for user files (resumes, cover letters, exports).
// Backed by Bun's native S3Client — zero npm dependency, talks the S3 wire
// protocol, and points at the local MinIO (infra/docker-compose.yml) in dev or
// real S3 in prod via the same config.
//
// Design notes:
//   - Like the LLM client, this degrades gracefully: when S3_ACCESS_KEY is
//     absent the client reports `available === false` and callers fall back
//     (no upload) instead of 500-ing, so the API boots in storage-less CI.
//   - Storage keys follow the layout documented in infra/CLAUDE.md:
//       {user_id}/resumes/originals/{file_id}.{ext}
//   - We never trust client-supplied paths for the key; the caller builds the
//     key from server-owned ids to prevent path traversal across users.

/** Thrown when object storage is unreachable or unconfigured. */
export class StorageUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

export interface PutResult {
  /** The storage key the object was written under. */
  key: string;
  /** Bytes written. */
  size: number;
}

export class StorageClient {
  private readonly client: S3Client | null;

  constructor(
    accessKey: string = config.S3_ACCESS_KEY,
    secretKey: string = config.S3_SECRET_KEY,
    private readonly bucket: string = config.S3_BUCKET,
    endpoint: string = config.S3_ENDPOINT,
    region: string = config.S3_REGION,
  ) {
    // Only construct a live client when credentials are present; otherwise the
    // client stays null and `available` is false.
    this.client =
      accessKey.length > 0 && secretKey.length > 0
        ? new S3Client({
            accessKeyId: accessKey,
            secretAccessKey: secretKey,
            bucket,
            endpoint,
            region,
          })
        : null;
  }

  /** True when credentials are configured and uploads will be attempted. */
  get available(): boolean {
    return this.client !== null;
  }

  /**
   * Write bytes under `key`. Throws StorageUnavailableError when storage is
   * not configured or the write fails, so the caller can decide whether the
   * upload is required or optional.
   */
  async put(
    key: string,
    data: Uint8Array | ArrayBuffer | Buffer,
    contentType: string,
  ): Promise<PutResult> {
    if (!this.client) {
      throw new StorageUnavailableError("Object storage is not configured");
    }
    const bytes =
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    try {
      await this.client.write(key, bytes, { type: contentType });
      return { key, size: bytes.byteLength };
    } catch (err) {
      throw new StorageUnavailableError(`Failed to write ${key}`, err);
    }
  }

  /** Read an object's bytes. Throws StorageUnavailableError on any failure. */
  async get(key: string): Promise<Uint8Array> {
    if (!this.client) {
      throw new StorageUnavailableError("Object storage is not configured");
    }
    try {
      const file = this.client.file(key);
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      throw new StorageUnavailableError(`Failed to read ${key}`, err);
    }
  }

  /**
   * Generate a time-limited presigned download URL for `key`. Returns null when
   * storage is unconfigured (caller falls back to "unavailable").
   *
   * MIME4 (round-16): the round-16 file-upload audit found that
   * presigned URLs were served by MinIO with no
   * `Content-Disposition` header — the browser inlined PDFs (and
   * would happily inline an HTML / SVG polyglot, executing
   * JavaScript at the storage origin where the API's `nosniff` and
   * CSP have no effect). Force `Content-Disposition: attachment`
   * via the S3 `response-content-disposition` query parameter so
   * presigned downloads always trigger a save dialog instead of
   * inline rendering. Derive a safe filename from the last path
   * segment of the key (storage keys follow
   * `{user_id}/resumes/originals/{file_id}.{ext}` — the segment is
   * server-generated, never user-controlled, so it's already safe
   * to embed in the header).
   */
  presign(
    key: string,
    expiresInSeconds = 300,
    disposition: "attachment" | "inline" = "attachment",
  ): string | null {
    if (!this.client) return null;
    const segments = key.split("/");
    const lastSegment = segments[segments.length - 1] || "download";
    const safeName = lastSegment.replace(/[^\w.\-]/g, "_");
    // `attachment` (default) forces a save dialog — used for downloads and for
    // any untrusted type (an HTML/SVG polyglot inlined at the storage origin
    // would dodge the API's nosniff/CSP). `inline` is opt-in and MUST only be
    // used for trusted, non-executable types (PDF) so the Resume Studio's
    // Original Pane can render the upload in an <iframe> instead of downloading
    // it (design §5.1). The caller is responsible for that type check.
    return this.client.presign(key, {
      expiresIn: expiresInSeconds,
      method: "GET",
      // Bun's S3Client maps this to the S3
      // `response-content-disposition` query parameter under the hood.
      contentDisposition: `${disposition}; filename="${safeName}"`,
    });
  }
}

/** Process-wide storage client using the configured credentials. */
export const storage = new StorageClient();
