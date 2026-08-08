import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseNativeOfficeFlags,
  verifyNativeOfficeArtifacts,
} from "./verify-native-office-artifacts";

describe("parseNativeOfficeFlags", () => {
  it("requires a renderer and renderer version", () => {
    expect(() => parseNativeOfficeFlags([])).toThrow("--renderer is required");
    expect(() => parseNativeOfficeFlags(["--renderer", "pages"])).toThrow(
      "--renderer-version is required",
    );
  });

  it("accepts only supported native Office renderers", () => {
    expect(() =>
      parseNativeOfficeFlags([
        "--renderer",
        "libreoffice",
        "--renderer-version",
        "1",
      ]),
    ).toThrow("--renderer must be either pages or word");
  });

  it("resolves explicit evidence paths and preserves the renderer identity", () => {
    const result = parseNativeOfficeFlags([
      "--renderer",
      "word",
      "--renderer-version",
      "16.99",
      "--input-dir",
      "tmp/word-exports",
      "--source-docx-dir",
      "tmp/source-docx",
    ]);

    expect(result).toEqual({
      renderer: "word",
      rendererVersion: "16.99",
      inputDir: resolve("tmp/word-exports"),
      sourceDocxDir: resolve("tmp/source-docx"),
    });
  });

  it("rejects missing values and unknown flags", () => {
    expect(() =>
      parseNativeOfficeFlags(["--renderer", "--renderer-version", "14.5"]),
    ).toThrow("--renderer requires a value");
    expect(() =>
      parseNativeOfficeFlags([
        "--renderer",
        "pages",
        "--renderer-version",
        "14.5",
        "--guess-pages",
      ]),
    ).toThrow("unknown argument: --guess-pages");
  });
});

describe("verifyNativeOfficeArtifacts", () => {
  it("preserves a failed manifest instead of treating missing exports as evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-native-office-"));
    const inputDir = join(root, "pages");
    const sourceDocxDir = join(root, "source");
    await Promise.all([
      mkdir(inputDir, { recursive: true }),
      mkdir(sourceDocxDir, { recursive: true }),
    ]);
    await writeFile(join(sourceDocxDir, "en-one-page.docx"), "source-docx");

    try {
      const result = await verifyNativeOfficeArtifacts({
        renderer: "pages",
        rendererVersion: "14.5",
        inputDir,
        sourceDocxDir,
      });
      const manifest = JSON.parse(
        await readFile(result.manifestPath, "utf8"),
      ) as {
        passed: boolean;
        cases: Array<{
          id: string;
          sourceDocxSha256: string | null;
          passed: boolean;
          error: string | null;
        }>;
      };

      expect(result.passed).toBe(false);
      expect(manifest.passed).toBe(false);
      expect(manifest.cases).toHaveLength(4);
      expect(manifest.cases.every((item) => !item.passed)).toBe(true);
      expect(manifest.cases[0].sourceDocxSha256).toHaveLength(64);
      expect(manifest.cases[0].error).toContain("en-one-page.pdf");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
