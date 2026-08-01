import { extractText, getDocumentProxy } from "unpdf";
import type { ResumeArtifactCalibrationCase } from "./resume-artifact-fixtures";

export type NativeOfficeRenderer = "pages" | "word";

export interface NativeOfficePdfInspection {
  pageCount: number;
  text: string;
  creator: string | null;
  producer: string | null;
}

export interface NativeOfficeArtifactEvaluation {
  expectedPages: number;
  actualPages: number;
  pageCountMatches: boolean;
  pdfCreator: string | null;
  pdfProducer: string | null;
  rendererIdentityMatches: boolean;
  textSentinels: readonly string[];
  missingTextSentinels: string[];
  passed: boolean;
}

/**
 * Evaluate the observable output of a native Office export.
 *
 * This deliberately does not inspect DOCX metadata or estimate pagination.
 * The caller must provide a PDF exported by the named desktop application,
 * so `actualPages` is the renderer's real output.
 */
export function evaluateNativeOfficeArtifact(
  renderer: NativeOfficeRenderer,
  calibrationCase: Pick<
    ResumeArtifactCalibrationCase,
    "expectedPages" | "officeTextSentinels"
  >,
  inspection: NativeOfficePdfInspection,
): NativeOfficeArtifactEvaluation {
  const missingTextSentinels = calibrationCase.officeTextSentinels.filter(
    (sentinel) => !inspection.text.includes(sentinel),
  );
  const pageCountMatches =
    inspection.pageCount === calibrationCase.expectedPages;
  const rendererIdentity = [inspection.creator, inspection.producer]
    .filter((value): value is string => value !== null)
    .join(" ");
  const rendererIdentityMatches =
    renderer === "pages"
      ? /\bpages\b/i.test(rendererIdentity)
      : /microsoft.*word|word.*microsoft/i.test(rendererIdentity);

  return {
    expectedPages: calibrationCase.expectedPages,
    actualPages: inspection.pageCount,
    pageCountMatches,
    pdfCreator: inspection.creator,
    pdfProducer: inspection.producer,
    rendererIdentityMatches,
    textSentinels: calibrationCase.officeTextSentinels,
    missingTextSentinels,
    passed:
      pageCountMatches &&
      rendererIdentityMatches &&
      missingTextSentinels.length === 0,
  };
}

export async function inspectNativeOfficePdf(
  pdfBytes: Uint8Array,
): Promise<NativeOfficePdfInspection> {
  const pdf = await getDocumentProxy(pdfBytes);
  try {
    const [{ text }, metadata] = await Promise.all([
      extractText(pdf, { mergePages: true }),
      pdf.getMetadata(),
    ]);
    const info = metadata.info as Record<string, unknown>;
    return {
      pageCount: pdf.numPages,
      text,
      creator: typeof info.Creator === "string" ? info.Creator : null,
      producer: typeof info.Producer === "string" ? info.Producer : null,
    };
  } finally {
    await pdf.destroy();
  }
}
