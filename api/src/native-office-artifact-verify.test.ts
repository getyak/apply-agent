import { describe, expect, it } from "bun:test";
import { evaluateNativeOfficeArtifact } from "./native-office-artifact-verify";

const calibrationCase = {
  expectedPages: 2 as const,
  officeTextSentinels: ["Candidate Name", "Final Achievement"] as const,
};

describe("evaluateNativeOfficeArtifact", () => {
  it("accepts the exact page budget when every text sentinel survives", () => {
    expect(
      evaluateNativeOfficeArtifact("pages", calibrationCase, {
        pageCount: 2,
        text: "Candidate Name\nExperience\nFinal Achievement",
        creator: "Pages",
        producer: "macOS Quartz PDFContext",
      }),
    ).toEqual({
      expectedPages: 2,
      actualPages: 2,
      pageCountMatches: true,
      pdfCreator: "Pages",
      pdfProducer: "macOS Quartz PDFContext",
      rendererIdentityMatches: true,
      textSentinels: ["Candidate Name", "Final Achievement"],
      missingTextSentinels: [],
      passed: true,
    });
  });

  it("rejects pagination drift even when the text is complete", () => {
    const result = evaluateNativeOfficeArtifact("pages", calibrationCase, {
      pageCount: 3,
      text: "Candidate Name\nFinal Achievement",
      creator: "Pages",
      producer: "macOS Quartz PDFContext",
    });

    expect(result.pageCountMatches).toBe(false);
    expect(result.missingTextSentinels).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it("reports every missing text sentinel", () => {
    const result = evaluateNativeOfficeArtifact("pages", calibrationCase, {
      pageCount: 2,
      text: "Candidate Name",
      creator: "Pages",
      producer: "macOS Quartz PDFContext",
    });

    expect(result.missingTextSentinels).toEqual(["Final Achievement"]);
    expect(result.passed).toBe(false);
  });

  it("rejects a PDF whose metadata does not identify the claimed renderer", () => {
    const result = evaluateNativeOfficeArtifact("word", calibrationCase, {
      pageCount: 2,
      text: "Candidate Name\nFinal Achievement",
      creator: "Pages",
      producer: "macOS Quartz PDFContext",
    });

    expect(result.rendererIdentityMatches).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("recognizes Microsoft Word creator metadata case-insensitively", () => {
    const result = evaluateNativeOfficeArtifact("word", calibrationCase, {
      pageCount: 2,
      text: "Candidate Name\nFinal Achievement",
      creator: "Microsoft Word for Microsoft 365",
      producer: null,
    });

    expect(result.rendererIdentityMatches).toBe(true);
    expect(result.passed).toBe(true);
  });
});
