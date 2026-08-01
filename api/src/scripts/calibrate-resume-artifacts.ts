import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderResumeDocx } from "../docx-export";
import { RESUME_ARTIFACT_CALIBRATION_CASES } from "../resume-artifact-fixtures";
import { resolveResumeArtifactProfile } from "../resume-artifact-profile";
import { jsonResumeToMarkdown } from "../resume-markdown";
import { closePdfRenderer, renderResumePdf } from "../pdf-render";

const outputDir = join(import.meta.dir, "../../scratch/resume-artifacts");
await mkdir(outputDir, { recursive: true });

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
  await Promise.all([
    writeFile(markdownPath, markdown),
    writeFile(pdfPath, pdf.bytes),
    writeFile(docxPath, docx.bytes),
  ]);
  manifest.push({
    id: calibrationCase.id,
    expectedPages: calibrationCase.expectedPages,
    pdfAudit: pdf.audit,
    docxAudit: docx.audit,
    files: { markdownPath, pdfPath, docxPath },
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
