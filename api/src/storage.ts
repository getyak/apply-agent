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
   */
  presign(key: string, expiresInSeconds = 300): string | null {
    if (!this.client) return null;
    return this.client.presign(key, {
      expiresIn: expiresInSeconds,
      method: "GET",
    });
  }
}

/** Process-wide storage client using the configured credentials. */
export const storage = new StorageClient();
