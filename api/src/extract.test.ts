import { describe, expect, test } from "bun:test";
import { classifyKind, extractText, ExtractionError } from "./extract";

describe("classifyKind", () => {
  test("classifies by MIME type", () => {
    expect(classifyKind("application/pdf", "x")).toBe("pdf");
    expect(
      classifyKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "x",
      ),
    ).toBe("docx");
    expect(classifyKind("text/plain", "x")).toBe("text");
    expect(classifyKind("text/markdown", "x")).toBe("text");
  });

  test("falls back to extension when MIME is generic", () => {
    expect(classifyKind("application/octet-stream", "resume.pdf")).toBe("pdf");
    expect(classifyKind("application/octet-stream", "resume.docx")).toBe("docx");
    expect(classifyKind("", "notes.txt")).toBe("text");
    expect(classifyKind("", "notes.md")).toBe("text");
  });

  test("returns null for unsupported types", () => {
    expect(classifyKind("image/png", "photo.png")).toBeNull();
    expect(classifyKind("application/zip", "archive.zip")).toBeNull();
    expect(classifyKind("", "noextension")).toBeNull();
  });
});

describe("extractText (text path)", () => {
  test("decodes UTF-8 text and normalizes whitespace", async () => {
    const input = "Jane Doe\r\n\r\n\r\n\r\nSoftware Engineer at Acme";
    const bytes = new TextEncoder().encode(input);
    const out = await extractText(bytes, "text");
    expect(out).toContain("Jane Doe");
    expect(out).toContain("Software Engineer");
    // CRLF normalized, 4+ newlines collapsed to a blank line.
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n\n\n");
  });

  test("rejects near-empty output", async () => {
    const bytes = new TextEncoder().encode("   hi   ");
    await expect(extractText(bytes, "text")).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });
});
