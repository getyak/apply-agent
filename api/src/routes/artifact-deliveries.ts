import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "../config";
import { query } from "../db";
import { NotFoundError } from "../errors";
import { resolveLocale } from "../locale";
import { rateLimit } from "../middleware/rate-limit";
import {
  artifactAttachmentHeader,
  renderResumeArtifactDelivery,
  type ResumeDeliveryFormat,
} from "../resume-artifact-delivery";
import { artifactAuditHeaders } from "../resume-artifact-profile";
import type { AppEnv } from "../types";

const deliveryLimiter = rateLimit({
  scope: "resume_artifact_delivery",
  limit: 30,
  windowSeconds: 60,
  keyFor: (c) =>
    c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "anon",
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOWNLOAD_CODE_RE = /^[a-f0-9]{64}$/;
const DOWNLOAD_COOKIE = "relay_artifact_code";
const DOWNLOAD_COOKIE_MAX_AGE_SECONDS = 10 * 60;

function unavailable(): never {
  throw new NotFoundError("Résumé artifact not available");
}

function grantId(value: string): string {
  if (!UUID_RE.test(value)) {
    unavailable();
  }
  return value;
}

function downloadPage(id: string): string {
  const action = `/api/public/artifacts/${encodeURIComponent(id)}/download`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Relay résumé artifact</title>
  </head>
  <body>
    <main>
      <h1>Download Relay résumé artifact</h1>
      <p>This short-lived page downloads a résumé for review or an approved application. It does not submit a job application.</p>
      <form method="post" action="${action}" autocomplete="off">
        <label>
          Relay download code
          <input name="download_code" type="password" required minlength="64" maxlength="64"
                 pattern="[a-f0-9]{64}" spellcheck="false" autocomplete="off">
        </label>
        <button type="submit">Download résumé</button>
      </form>
    </main>
  </body>
</html>`;
}

function downloadPath(id: string): string {
  return `/api/public/artifacts/${encodeURIComponent(id)}/download`;
}

interface DeliveryRow {
  purpose: "compilation_review" | "application_upload";
  artifact_format: ResumeDeliveryFormat;
  content: unknown;
  version: number;
  compiler_config: unknown;
  compilation_id: string;
  application_id: string | null;
}

interface ArtifactDeliveryDependencies {
  query: typeof query;
  render: typeof renderResumeArtifactDelivery;
}

const defaultDependencies: ArtifactDeliveryDependencies = {
  query,
  render: renderResumeArtifactDelivery,
};

export function createArtifactDeliveryRoutes(
  dependencies: ArtifactDeliveryDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", deliveryLimiter);

  app.get("/:grantId", (c) => {
    const id = grantId(c.req.param("grantId"));
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.html(downloadPage(id));
  });

  app.post("/:grantId/download", async (c) => {
    const id = grantId(c.req.param("grantId"));
    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      unavailable();
    }
    const rawCode = body.download_code;
    if (typeof rawCode !== "string" || !DOWNLOAD_CODE_RE.test(rawCode)) {
      unavailable();
    }
    const path = downloadPath(id);
    setCookie(c, DOWNLOAD_COOKIE, rawCode, {
      httpOnly: true,
      sameSite: "Strict",
      secure:
        config.NODE_ENV === "production" ||
        new URL(c.req.url).protocol === "https:",
      path,
      maxAge: DOWNLOAD_COOKIE_MAX_AGE_SECONDS,
    });
    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.redirect(path, 303);
  });

  app.on(["GET", "HEAD"], "/:grantId/download", async (c) => {
    const id = grantId(c.req.param("grantId"));
    const rawCode = getCookie(c, DOWNLOAD_COOKIE);
    if (typeof rawCode !== "string" || !DOWNLOAD_CODE_RE.test(rawCode)) {
      unavailable();
    }
    // Chrome's download manager probes an attachment with HEAD after the real
    // GET. Validate only the path-scoped cookie shape here so that a probe
    // does not consume one of the bounded downloads or render the file again.
    // This metadata-free response reveals nothing about UUID/code existence.
    if (c.req.method === "HEAD") {
      return c.body(null, 200, {
        "Cache-Control": "private, no-store, max-age=0",
      });
    }
    const digest = createHash("sha256").update(rawCode, "utf8").digest("hex");
    const result = await dependencies.query<DeliveryRow>(
      `SELECT purpose, artifact_format, content, version, compiler_config,
              compilation_id, application_id
         FROM consume_resume_artifact_delivery_grant($1, $2)`,
      [id, digest],
    );
    const row = result.rows[0];
    if (!row) {
      unavailable();
    }

    const artifact = await dependencies.render(
      {
        content: row.content,
        version: row.version,
        compilerConfig: row.compiler_config,
      },
      row.artifact_format,
      resolveLocale(c),
    );
    if (!artifact) {
      return c.json(
        {
          error: {
            code: "ARTIFACT_RENDERER_UNAVAILABLE",
            message: `${row.artifact_format.toUpperCase()} renderer is unavailable`,
          },
        },
        503,
        { "Cache-Control": "no-store" },
      );
    }

    const bytes = artifact.bytes;
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    return c.body(arrayBuffer as ArrayBuffer, 200, {
      "content-type": artifact.mimeType,
      "content-disposition": artifactAttachmentHeader(artifact.filename),
      "content-length": String(arrayBuffer.byteLength),
      "cache-control": "private, no-store, max-age=0",
      "x-relay-artifact-compilation-id": row.compilation_id,
      "x-relay-artifact-purpose": row.purpose,
      ...(row.application_id
        ? { "x-relay-artifact-application-id": row.application_id }
        : {}),
      ...artifactAuditHeaders(artifact.audit),
    });
  });

  return app;
}

export default createArtifactDeliveryRoutes();
