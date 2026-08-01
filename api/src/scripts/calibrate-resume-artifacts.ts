import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { renderResumeDocx } from "../docx-export";
import {
  convertDocxToPdf,
  docxPreviewAvailable,
} from "../docx-preview";
import { RESUME_ARTIFACT_CALIBRATION_CASES } from "../resume-artifact-fixtures";
import { resolveResumeArtifactProfile } from "../resume-artifact-profile";
import { jsonResumeToMarkdown } from "../resume-markdown";
import { closePdfRenderer, renderResumePdf } from "../pdf-render";

const outputDir = join(import.meta.dir, "../../scratch/resume-artifacts");
await mkdir(outputDir, { recursive: true });
const requireLibreOffice = process.argv.includes("--require-libreoffice");
const hasLibreOffice = await docxPreviewAvailable();
if (requireLibreOffice && !hasLibreOffice) {
  throw new Error(
    "LibreOffice is required for this calibration but soffice/libreoffice is unavailable",
  );
}

const manifest: Record<string, unknown>[] = [];
for (const calibrationCase of RESUME_ARTIFACT_CALIBRATION_CASES) {
  const profile = resolveResumeArtifactProfile({
    profile_version: 1,
    artifact_locale: calibrationCase.locale,
    length_budget: calibrationCase.lengthBudget,
    ats_profile: "strict",
  });
  const markdown = jsonResumeToMarkdown(calibrationCase.resume, {
    locale: calibrationCase.locale,
  });
  const pdf = await renderResumePdf(markdown, profile);
  const docx = await renderResumeDocx(markdown, profile);
  if (!docx) {
    throw new Error("Pandoc or Relay reference DOCX assets are unavailable");
  }

  const markdownPath = join(outputDir, `${calibrationCase.id}.md`);
  const pdfPath = join(outputDir, `${calibrationCase.id}.pdf`);
  const docxPath = join(outputDir, `${calibrationCase.id}.docx`);
  const officePdfPath = join(
    outputDir,
    `${calibrationCase.id}.libreoffice.pdf`,
  );
  await Promise.all([
    writeFile(markdownPath, markdown),
    writeFile(pdfPath, pdf.bytes),
    writeFile(docxPath, docx.bytes),
  ]);
  let libreOfficeAudit: Record<string, unknown> | null = null;
  if (hasLibreOffice) {
    const officePdfBytes = await convertDocxToPdf(docx.bytes);
    if (!officePdfBytes) {
      throw new Error(
        `${calibrationCase.id}: LibreOffice failed to convert the DOCX`,
      );
    }
    // Preserve the renderer output even when a later assertion fails so the
    // offending page can be inspected rather than diagnosed from estimates.
    await writeFile(officePdfPath, officePdfBytes);
    const officePdf = await getDocumentProxy(new Uint8Array(officePdfBytes));
    try {
      const { text } = await extractText(officePdf, { mergePages: true });
      const missingTextSentinels = calibrationCase.officeTextSentinels.filter(
        (sentinel) => !text.includes(sentinel),
      );
      libreOfficeAudit = {
        renderer: "libreoffice",
        pageCount: officePdf.numPages,
        expectedPages: calibrationCase.expectedPages,
        withinBudget: officePdf.numPages === calibrationCase.expectedPages,
        textSentinels: calibrationCase.officeTextSentinels,
        missingTextSentinels,
      };
      if (officePdf.numPages !== calibrationCase.expectedPages) {
        throw new Error(
          `${calibrationCase.id}: expected ${calibrationCase.expectedPages} LibreOffice page(s), rendered ${officePdf.numPages}`,
        );
      }
      if (missingTextSentinels.length > 0) {
        throw new Error(
          `${calibrationCase.id}: LibreOffice PDF is missing text: ${missingTextSentinels.join(", ")}`,
        );
      }
    } finally {
      await officePdf.destroy();
    }
  }
  manifest.push({
    id: calibrationCase.id,
    expectedPages: calibrationCase.expectedPages,
    pdfAudit: pdf.audit,
    docxAudit: docx.audit,
    libreOfficeAudit,
    files: {
      markdownPath,
      pdfPath,
      docxPath,
      officePdfPath: hasLibreOffice ? officePdfPath : null,
    },
  });
  if (pdf.audit.pageCount !== calibrationCase.expectedPages) {
    throw new Error(
      `${calibrationCase.id}: expected ${calibrationCase.expectedPages} PDF page(s), rendered ${pdf.audit.pageCount}`,
    );
  }
}

const manifestPath = join(outputDir, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await closePdfRenderer();
console.log(manifestPath);
