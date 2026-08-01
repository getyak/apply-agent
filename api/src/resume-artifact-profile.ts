import type { SupportedLocale } from "./locale";

export const RESUME_ARTIFACT_RENDERER_VERSION = 1;

export const RESUME_ARTIFACT_AUDIT_HEADER_NAMES = [
  "x-relay-artifact-renderer-version",
  "x-relay-artifact-format",
  "x-relay-artifact-locale",
  "x-relay-artifact-length-budget",
  "x-relay-artifact-target-pages",
  "x-relay-artifact-page-count",
  "x-relay-artifact-within-budget",
] as const;

export type ResumeLengthBudget = "one_page" | "two_page";
export type ResumeAtsProfile = "standard" | "strict";

export interface ResumeArtifactProfile {
  rendererVersion: number;
  preset: "compact_reference_guide";
  namedOverrides: readonly ["ats_resume_a4", "monochrome_ats_header"];
  compilerProfileVersion: number;
  artifactLocale: SupportedLocale;
  lengthBudget: ResumeLengthBudget;
  atsProfile: ResumeAtsProfile;
  targetPages: 1 | 2;
  page: {
    format: "A4";
    widthMm: 210;
    heightMm: 297;
    marginTopMm: 12;
    marginRightMm: 14;
    marginBottomMm: 12;
    marginLeftMm: 14;
  };
  typography: {
    bodyFont: "Arial";
    eastAsiaFont: "Microsoft YaHei";
    bodySizePt: number;
    bodyLineHeight: number;
    nameSizePt: number;
    sectionSizePt: number;
    roleSizePt: number;
    bulletIndentMm: number;
  };
}

const PROFILE_TOKENS: Record<
  ResumeLengthBudget,
  Pick<
    ResumeArtifactProfile["typography"],
    "bodySizePt" | "bodyLineHeight" | "nameSizePt" | "sectionSizePt" | "roleSizePt"
  >
> = {
  one_page: {
    bodySizePt: 9.5,
    bodyLineHeight: 1.2,
    nameSizePt: 20,
    sectionSizePt: 10.25,
    roleSizePt: 9.75,
  },
  two_page: {
    bodySizePt: 10.5,
    bodyLineHeight: 1.28,
    nameSizePt: 21,
    sectionSizePt: 11,
    roleSizePt: 10.5,
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolve persisted compiler inputs into a closed, deterministic file-layout
 * profile. Unknown/legacy values degrade to the conservative two-page profile;
 * request locale is used only when the compilation did not persist one.
 */
export function resolveResumeArtifactProfile(
  compilerConfig: unknown,
  fallbackLocale: SupportedLocale = "en",
): ResumeArtifactProfile {
  const config = asRecord(compilerConfig);
  const artifactLocale: SupportedLocale =
    config.artifact_locale === "en" || config.artifact_locale === "zh"
      ? config.artifact_locale
      : fallbackLocale;
  const lengthBudget: ResumeLengthBudget =
    config.length_budget === "one_page" || config.length_budget === "two_page"
      ? config.length_budget
      : "two_page";
  const atsProfile: ResumeAtsProfile =
    config.ats_profile === "strict" ? "strict" : "standard";
  const compilerProfileVersion =
    typeof config.profile_version === "number" &&
    Number.isInteger(config.profile_version) &&
    config.profile_version >= 0
      ? config.profile_version
      : 0;
  const targetPages = lengthBudget === "one_page" ? 1 : 2;

  return {
    rendererVersion: RESUME_ARTIFACT_RENDERER_VERSION,
    preset: "compact_reference_guide",
    namedOverrides: ["ats_resume_a4", "monochrome_ats_header"],
    compilerProfileVersion,
    artifactLocale,
    lengthBudget,
    atsProfile,
    targetPages,
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
      bodyFont: "Arial",
      eastAsiaFont: "Microsoft YaHei",
      ...PROFILE_TOKENS[lengthBudget],
      bulletIndentMm: 4.8,
    },
  };
}

export interface ResumeArtifactAudit {
  rendererVersion: number;
  format: "pdf" | "docx";
  artifactLocale: SupportedLocale;
  lengthBudget: ResumeLengthBudget;
  atsProfile: ResumeAtsProfile;
  targetPages: 1 | 2;
  pageCount: number | null;
  withinBudget: boolean | null;
}

export function artifactAuditHeaders(audit: ResumeArtifactAudit): Record<string, string> {
  const headers: Record<string, string> = {
    "x-relay-artifact-renderer-version": String(audit.rendererVersion),
    "x-relay-artifact-format": audit.format,
    "x-relay-artifact-locale": audit.artifactLocale,
    "x-relay-artifact-length-budget": audit.lengthBudget,
    "x-relay-artifact-target-pages": String(audit.targetPages),
  };
  if (audit.pageCount !== null) {
    headers["x-relay-artifact-page-count"] = String(audit.pageCount);
  }
  if (audit.withinBudget !== null) {
    headers["x-relay-artifact-within-budget"] = String(audit.withinBudget);
  }
  return headers;
}
