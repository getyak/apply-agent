import { describe, expect, test } from "bun:test";
import server from "./index";
import { RESUME_ARTIFACT_AUDIT_HEADER_NAMES } from "./resume-artifact-profile";

describe("api", () => {
  test("exposes download metadata to the allowlisted web origin", async () => {
    const response = await server.fetch(
      new Request("http://localhost/api/resumes/example/export?format=pdf", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "GET",
        },
      }),
    );
    const exposed = new Set(
      (response.headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean),
    );

    expect(response.status).toBe(204);
    expect(exposed).toContain("content-disposition");
    for (const header of RESUME_ARTIFACT_AUDIT_HEADER_NAMES) {
      expect(exposed).toContain(header);
    }
  });
});
