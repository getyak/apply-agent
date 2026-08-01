import { afterAll, describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { extractRawText } from "mammoth";
import { docxExportAvailable, renderResumeDocx } from "./docx-export";
import { RESUME_ARTIFACT_CALIBRATION_CASES } from "./resume-artifact-fixtures";
import { resolveResumeArtifactProfile } from "./resume-artifact-profile";
import { jsonResumeToMarkdown } from "./resume-markdown";
import {
  closePdfRenderer,
  pdfRenderAvailable,
  renderResumePdf,
} from "./pdf-render";

const hasPdfRenderer = await pdfRenderAvailable();
const hasDocxRenderer = await docxExportAvailable();

describe.if(hasPdfRenderer)("resume PDF calibration", () => {
  afterAll(async () => {
    await closePdfRenderer();
  });

  for (const calibrationCase of RESUME_ARTIFACT_CALIBRATION_CASES) {
    test(
      `${calibrationCase.id} renders to its calibrated page count`,
      async () => {
        const profile = resolveResumeArtifactProfile({
          profile_version: 1,
          artifact_locale: calibrationCase.locale,
          length_budget: calibrationCase.lengthBudget,
          ats_profile: "strict",
        });
        const markdown = jsonResumeToMarkdown(calibrationCase.resume, {
          locale: calibrationCase.locale,
        });
        const artifact = await renderResumePdf(markdown, profile);

        expect(artifact.bytes.subarray(0, 5).toString()).toBe("%PDF-");
        expect(artifact.audit.pageCount).toBe(calibrationCase.expectedPages);
        expect(artifact.audit.withinBudget).toBe(true);
      },
      20_000,
    );
  }
});

describe.if(hasDocxRenderer)("resume DOCX calibration", () => {
  test(
    "produces a real, text-preserving DOCX from the closed profile",
    async () => {
      const calibrationCase = RESUME_ARTIFACT_CALIBRATION_CASES[0];
      const markdown = jsonResumeToMarkdown(calibrationCase.resume, {
        locale: calibrationCase.locale,
      });
      const artifact = await renderResumeDocx(
        markdown,
        resolveResumeArtifactProfile({
          artifact_locale: calibrationCase.locale,
          length_budget: calibrationCase.lengthBudget,
          ats_profile: "strict",
        }),
      );

      expect(artifact).not.toBeNull();
      expect(Buffer.from(artifact!.bytes.subarray(0, 2)).toString()).toBe("PK");
      expect(artifact!.audit.pageCount).toBeNull();
      const archive = unzipSync(artifact!.bytes);
      const numbering = strFromU8(archive["word/numbering.xml"]);
      expect(numbering).toContain('w:lvlText w:val="•"');
      expect(numbering).not.toContain('w:ascii="Symbol"');
      expect(numbering).toContain('w:left="272" w:hanging="125"');
      const extracted = await extractRawText({
        buffer: Buffer.from(artifact!.bytes),
      });
      expect(extracted.value).toContain("Avery Lin");
      expect(extracted.value).toContain("Northstar Systems");
      expect(extracted.value).toContain("Release Evidence Ledger");
    },
    20_000,
  );
});
