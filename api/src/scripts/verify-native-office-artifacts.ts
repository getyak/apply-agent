import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  evaluateNativeOfficeArtifact,
  inspectNativeOfficePdf,
  type NativeOfficeRenderer,
} from "../native-office-artifact-verify";
import { RESUME_ARTIFACT_CALIBRATION_CASES } from "../resume-artifact-fixtures";

interface NativeOfficeCliFlags {
  renderer: NativeOfficeRenderer;
  rendererVersion: string;
  inputDir: string;
  sourceDocxDir: string;
}

interface NativeOfficeCaseResult {
  id: string;
  sourceDocxFile: string;
  sourceDocxSha256: string | null;
  exportedPdfFile: string;
  exportedPdfSha256: string | null;
  expectedPages: number;
  actualPages: number | null;
  pageCountMatches: boolean;
  pdfCreator: string | null;
  pdfProducer: string | null;
  rendererIdentityMatches: boolean;
  textSentinels: readonly string[];
  missingTextSentinels: string[];
  passed: boolean;
  error: string | null;
}

const artifactRoot = join(import.meta.dir, "../../scratch/resume-artifacts");

function requireFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseNativeOfficeFlags(argv: string[]): NativeOfficeCliFlags {
  let renderer: NativeOfficeRenderer | undefined;
  let rendererVersion: string | undefined;
  let inputDir: string | undefined;
  let sourceDocxDir = artifactRoot;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--renderer") {
      const value = requireFlagValue(argv, index, flag);
      if (value !== "pages" && value !== "word") {
        throw new Error("--renderer must be either pages or word");
      }
      renderer = value;
      index++;
    } else if (flag === "--renderer-version") {
      rendererVersion = requireFlagValue(argv, index, flag);
      index++;
    } else if (flag === "--input-dir") {
      inputDir = requireFlagValue(argv, index, flag);
      index++;
    } else if (flag === "--source-docx-dir") {
      sourceDocxDir = requireFlagValue(argv, index, flag);
      index++;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }

  if (!renderer) {
    throw new Error("--renderer is required");
  }
  if (!rendererVersion) {
    throw new Error("--renderer-version is required");
  }

  const resolvePath = (path: string) =>
    isAbsolute(path) ? path : resolve(process.cwd(), path);

  return {
    renderer,
    rendererVersion,
    inputDir: resolvePath(
      inputDir ?? join(artifactRoot, "native-office", renderer),
    ),
    sourceDocxDir: resolvePath(sourceDocxDir),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function verifyNativeOfficeArtifacts(
  flags: NativeOfficeCliFlags,
): Promise<{ manifestPath: string; passed: boolean }> {
  const inputStat = await stat(flags.inputDir).catch(() => null);
  if (!inputStat?.isDirectory()) {
    throw new Error(
      `native Office export directory does not exist: ${flags.inputDir}`,
    );
  }

  const results: NativeOfficeCaseResult[] = [];
  for (const calibrationCase of RESUME_ARTIFACT_CALIBRATION_CASES) {
    const sourceDocxFile = `${calibrationCase.id}.docx`;
    const exportedPdfFile = `${calibrationCase.id}.pdf`;
    const sourceDocxPath = join(flags.sourceDocxDir, sourceDocxFile);
    const exportedPdfPath = join(flags.inputDir, exportedPdfFile);
    let sourceDocxSha256: string | null = null;
    let exportedPdfSha256: string | null = null;

    try {
      const sourceDocxBytes = await readFile(sourceDocxPath);
      sourceDocxSha256 = sha256(sourceDocxBytes);
      const exportedPdfBytes = await readFile(exportedPdfPath);
      exportedPdfSha256 = sha256(exportedPdfBytes);
      const inspection = await inspectNativeOfficePdf(exportedPdfBytes);
      const evaluation = evaluateNativeOfficeArtifact(
        flags.renderer,
        calibrationCase,
        inspection,
      );
      results.push({
        id: calibrationCase.id,
        sourceDocxFile,
        sourceDocxSha256,
        exportedPdfFile,
        exportedPdfSha256,
        ...evaluation,
        error: null,
      });
    } catch (error) {
      results.push({
        id: calibrationCase.id,
        sourceDocxFile,
        sourceDocxSha256,
        exportedPdfFile,
        exportedPdfSha256,
        expectedPages: calibrationCase.expectedPages,
        actualPages: null,
        pageCountMatches: false,
        pdfCreator: null,
        pdfProducer: null,
        rendererIdentityMatches: false,
        textSentinels: calibrationCase.officeTextSentinels,
        missingTextSentinels: [...calibrationCase.officeTextSentinels],
        passed: false,
        error: errorMessage(error),
      });
    }
  }

  const passed = results.every((result) => result.passed);
  const manifestPath = join(flags.inputDir, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        verifiedAt: new Date().toISOString(),
        renderer: flags.renderer,
        rendererVersion: flags.rendererVersion,
        passed,
        cases: results,
      },
      null,
      2,
    )}\n`,
  );

  return { manifestPath, passed };
}

async function main() {
  try {
    const flags = parseNativeOfficeFlags(process.argv.slice(2));
    const result = await verifyNativeOfficeArtifacts(flags);
    console.log(result.manifestPath);
    if (!result.passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void main();
}
