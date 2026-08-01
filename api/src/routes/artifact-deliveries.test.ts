import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { query as dbQuery } from "../db";
import { errorHandler } from "../errors";
import type { renderResumeArtifactDelivery } from "../resume-artifact-delivery";
import type { AppEnv } from "../types";
import { createArtifactDeliveryRoutes } from "./artifact-deliveries";

const GRANT_ID = "00000000-0000-4000-8000-000000000d01";
const COMPILATION_ID = "00000000-0000-4000-8000-000000000d02";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000d03";
const DOWNLOAD_CODE = "ab".repeat(32);

let rows: Array<Record<string, unknown>>;
let queryCalls: Array<{ text: string; params?: unknown[] }>;
let rendererAvailable: boolean;

const stubQuery = (async (text: string, params?: unknown[]) => {
  queryCalls.push({ text, params });
  return { rows };
}) as typeof dbQuery;

const stubRender = (async () => {
  if (!rendererAvailable) return null;
  return {
    bytes: new TextEncoder().encode("%PDF-relay-test"),
    filename: "avery-lin-v7.pdf",
    mimeType: "application/pdf",
    audit: {
      rendererVersion: 2,
      format: "pdf" as const,
      artifactLocale: "en" as const,
      lengthBudget: "one_page" as const,
      atsProfile: "strict" as const,
      targetPages: 1 as const,
      pageCount: 1,
      withinBudget: true,
    },
  };
}) as typeof renderResumeArtifactDelivery;

const app = new Hono<AppEnv>();
app.route(
  "/api/public/artifacts",
  createArtifactDeliveryRoutes({ query: stubQuery, render: stubRender }),
);
app.onError(errorHandler);

async function authorizeDownload(code: string): Promise<Response> {
  return await app.request(`/api/public/artifacts/${GRANT_ID}/download`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ download_code: code }).toString(),
  });
}

async function getDownload(cookie: string): Promise<Response> {
  return await app.request(`/api/public/artifacts/${GRANT_ID}/download`, {
    headers: { cookie },
  });
}

async function downloadWithCode(code: string): Promise<Response> {
  const authorized = await authorizeDownload(code);
  expect(authorized.status).toBe(303);
  const cookie = authorized.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return await getDownload(cookie!);
}

describe("short-lived résumé artifact delivery", () => {
  beforeEach(() => {
    rows = [
      {
        purpose: "application_upload",
        artifact_format: "pdf",
        content: {
          parsed: { basics: { name: "Avery Lin" } },
          artifactLocale: "en",
        },
        version: 7,
        compiler_config: {
          profile_version: 1,
          artifact_locale: "en",
          length_budget: "one_page",
          ats_profile: "strict",
        },
        compilation_id: COMPILATION_ID,
        application_id: APPLICATION_ID,
      },
    ];
    queryCalls = [];
    rendererAvailable = true;
  });

  it("serves a no-store download-code form without disclosing a capability", async () => {
    const response = await app.request(
      `/api/public/artifacts/${GRANT_ID}`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(html).toContain('name="download_code"');
    expect(html).toContain("does not submit a job application");
    expect(html).not.toContain(DOWNLOAD_CODE);
    expect(queryCalls).toHaveLength(0);
  });

  it("rejects malformed grant ids and download codes before querying", async () => {
    const badGrant = await app.request("/api/public/artifacts/not-a-grant");
    const badCode = await authorizeDownload("too-short");
    const missingCookie = await getDownload("");

    expect(badGrant.status).toBe(404);
    expect(badCode.status).toBe(404);
    expect(missingCookie.status).toBe(404);
    expect(queryCalls).toHaveLength(0);
  });

  it("moves the code into a short-lived path-scoped HttpOnly cookie before GET", async () => {
    const response = await authorizeDownload(DOWNLOAD_CODE);
    const cookie = response.headers.get("set-cookie") ?? "";
    const location = response.headers.get("location") ?? "";

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(cookie).toContain(`relay_artifact_code=${DOWNLOAD_CODE}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(
      `Path=/api/public/artifacts/${GRANT_ID}/download`,
    );
    expect(location).toBe(`/api/public/artifacts/${GRANT_ID}/download`);
    expect(location).not.toContain(DOWNLOAD_CODE);
    expect(queryCalls).toHaveLength(0);
  });

  it("answers Chrome's HEAD probe without consuming or rendering a grant", async () => {
    const response = await app.request(
      `/api/public/artifacts/${GRANT_ID}/download`,
      {
        method: "HEAD",
        headers: {
          cookie: `relay_artifact_code=${DOWNLOAD_CODE}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(queryCalls).toHaveLength(0);
  });

  it("hashes the code, atomically consumes a bounded grant, and streams the artifact", async () => {
    const response = await downloadWithCode(DOWNLOAD_CODE);
    const call = queryCalls[0]!;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF-relay-test");
    expect(call.params).toEqual([
      GRANT_ID,
      createHash("sha256").update(DOWNLOAD_CODE).digest("hex"),
    ]);
    expect(JSON.stringify(call.params)).not.toContain(DOWNLOAD_CODE);
    expect(call.text).toContain(
      "FROM consume_resume_artifact_delivery_grant($1, $2)",
    );
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      "avery-lin-v7.pdf",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-relay-artifact-compilation-id")).toBe(
      COMPILATION_ID,
    );
    expect(response.headers.get("x-relay-artifact-application-id")).toBe(
      APPLICATION_ID,
    );
    expect(response.headers.get("x-relay-artifact-purpose")).toBe(
      "application_upload",
    );
    expect(response.headers.get("x-relay-artifact-page-count")).toBe("1");
  });

  it("delivers a draft review artifact without inventing an application binding", async () => {
    rows[0] = {
      ...rows[0],
      purpose: "compilation_review",
      application_id: null,
    };

    const response = await downloadWithCode(DOWNLOAD_CODE);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-relay-artifact-purpose")).toBe(
      "compilation_review",
    );
    expect(response.headers.has("x-relay-artifact-application-id")).toBeFalse();
  });

  it("uses the same 404 for an expired, revoked, exhausted, or wrong-code grant", async () => {
    rows = [];
    const response = await downloadWithCode(DOWNLOAD_CODE);

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe(
      "Résumé artifact not available",
    );
  });

  it("fails closed when the pinned renderer is unavailable", async () => {
    rendererAvailable = false;
    const response = await downloadWithCode(DOWNLOAD_CODE);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error.code).toBe(
      "ARTIFACT_RENDERER_UNAVAILABLE",
    );
  });
});
