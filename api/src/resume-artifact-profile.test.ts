import { describe, expect, test } from "bun:test";
import {
  RESUME_ARTIFACT_AUDIT_HEADER_NAMES,
  artifactAuditHeaders,
  resolveResumeArtifactProfile,
} from "./resume-artifact-profile";

describe("resolveResumeArtifactProfile", () => {
  test("maps persisted compiler inputs to a closed one-page profile", () => {
    const profile = resolveResumeArtifactProfile({
      profile_version: 3,
      artifact_locale: "zh",
      length_budget: "one_page",
      ats_profile: "strict",
      ignored_layout_override: "A3",
    });

    expect(profile).toMatchObject({
      rendererVersion: 2,
      compilerProfileVersion: 3,
      artifactLocale: "zh",
      lengthBudget: "one_page",
      atsProfile: "strict",
      targetPages: 1,
      page: {
        format: "A4",
        widthMm: 210,
        heightMm: 297,
        marginTopMm: 12,
        marginRightMm: 14,
        marginBottomMm: 12,
        marginLeftMm: 14,
      },
      typography: {
        bodyLineHeight: 1.2,
        sectionBeforeMm: 2.8,
        paragraphAfterMm: 0.9,
        bulletAfterMm: 0.45,
      },
    });
    expect(profile.namedOverrides).toEqual([
      "ats_resume_a4",
      "monochrome_ats_header",
    ]);
  });

  test("uses a conservative two-page fallback for legacy or invalid input", () => {
    const profile = resolveResumeArtifactProfile(
      {
        profile_version: -1,
        artifact_locale: "fr",
        length_budget: "poster",
        ats_profile: "unknown",
      },
      "zh",
    );

    expect(profile).toMatchObject({
      compilerProfileVersion: 0,
      artifactLocale: "zh",
      lengthBudget: "two_page",
      atsProfile: "standard",
      targetPages: 2,
      typography: {
        bodyLineHeight: 1.2,
        sectionBeforeMm: 3.4,
        paragraphAfterMm: 1,
        bulletAfterMm: 0.55,
      },
    });
  });
});

describe("artifactAuditHeaders", () => {
  test("publishes measured values and omits unknown DOCX page facts", () => {
    const profile = resolveResumeArtifactProfile({
      artifact_locale: "en",
      length_budget: "two_page",
    });
    const headers = artifactAuditHeaders({
      rendererVersion: profile.rendererVersion,
      format: "docx",
      artifactLocale: profile.artifactLocale,
      lengthBudget: profile.lengthBudget,
      atsProfile: profile.atsProfile,
      targetPages: profile.targetPages,
      pageCount: null,
      withinBudget: null,
    });

    expect(headers["x-relay-artifact-target-pages"]).toBe("2");
    expect(headers["x-relay-artifact-page-count"]).toBeUndefined();
    expect(headers["x-relay-artifact-within-budget"]).toBeUndefined();
  });

  test("keeps the browser-visible audit header contract explicit", () => {
    expect(RESUME_ARTIFACT_AUDIT_HEADER_NAMES).toEqual([
      "x-relay-artifact-renderer-version",
      "x-relay-artifact-format",
      "x-relay-artifact-locale",
      "x-relay-artifact-length-budget",
      "x-relay-artifact-target-pages",
      "x-relay-artifact-page-count",
      "x-relay-artifact-within-budget",
    ]);
  });
});
