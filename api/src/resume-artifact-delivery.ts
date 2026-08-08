import { renderResumeDocx, docxExportAvailable } from "./docx-export";
import { EXPORT_MIME, exportFilename } from "./resume-export";
import { jsonResumeToMarkdown } from "./resume-markdown";
import { pdfRenderAvailable, renderResumePdf } from "./pdf-render";
import {
  resolveResumeArtifactProfile,
  type ResumeArtifactAudit,
} from "./resume-artifact-profile";
import type { JsonResume } from "./resume-parse";
import type { SupportedLocale } from "./locale";

export type ResumeDeliveryFormat = "pdf" | "docx";

export interface ResumeArtifactDeliverySource {
  content: unknown;
  version: number;
  compilerConfig?: unknown;
}

export interface RenderedResumeArtifactDelivery {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  audit: ResumeArtifactAudit;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unwrapDeliverySource(
  source: ResumeArtifactDeliverySource,
  fallbackLocale: SupportedLocale,
): {
  parsed: JsonResume;
  markdown: string;
  compilerConfig: unknown;
  artifactLocale: SupportedLocale;
} {
  const content = asRecord(source.content);
  const wrapped = asRecord(content.parsed);
  const parsed = (
    Object.keys(wrapped).length > 0 ? wrapped : content
  ) as JsonResume;
  const persistedCompilerConfig =
    source.compilerConfig ?? content.compilerConfig;
  const compilerConfig = asRecord(persistedCompilerConfig);
  const artifactLocale: SupportedLocale =
    compilerConfig.artifact_locale === "en" ||
    compilerConfig.artifact_locale === "zh"
      ? compilerConfig.artifact_locale
      : content.artifactLocale === "en" || content.artifactLocale === "zh"
        ? content.artifactLocale
        : fallbackLocale;
  const markdown =
    typeof content.markdown === "string" && content.markdown.length > 0
      ? content.markdown
      : jsonResumeToMarkdown(parsed, { locale: artifactLocale });

  return {
    parsed,
    markdown,
    compilerConfig: persistedCompilerConfig,
    artifactLocale,
  };
}

/**
 * Render the same immutable résumé row used by the authenticated export route.
 * A null result means the requested server-side renderer is unavailable.
 */
export async function renderResumeArtifactDelivery(
  source: ResumeArtifactDeliverySource,
  format: ResumeDeliveryFormat,
  fallbackLocale: SupportedLocale = "en",
): Promise<RenderedResumeArtifactDelivery | null> {
  const { parsed, markdown, compilerConfig, artifactLocale } =
    unwrapDeliverySource(source, fallbackLocale);
  const profile = resolveResumeArtifactProfile(
    compilerConfig,
    artifactLocale,
  );
  const filename = exportFilename(parsed, `v${source.version}`, format);

  if (format === "pdf") {
    if (!(await pdfRenderAvailable())) {
      return null;
    }
    const artifact = await renderResumePdf(markdown, profile);
    return {
      bytes: artifact.bytes,
      filename,
      mimeType: EXPORT_MIME.pdf,
      audit: artifact.audit,
    };
  }

  if (!(await docxExportAvailable())) {
    return null;
  }
  const artifact = await renderResumeDocx(markdown, profile);
  if (!artifact) {
    return null;
  }
  return {
    bytes: artifact.bytes,
    filename,
    mimeType: EXPORT_MIME.docx,
    audit: artifact.audit,
  };
}

export function artifactAttachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
