import { describe, expect, test } from "bun:test";
import {
  bytesToMarkdown,
  textToMarkdownHeuristic,
  ExtractionError,
} from "./markdown";

const enc = (s: string) => new TextEncoder().encode(s);

describe("textToMarkdownHeuristic (PDF line heuristics)", () => {
  test("promotes ALL-CAPS section labels to ## headings", () => {
    const out = textToMarkdownHeuristic("EXPERIENCE\nWorked at Acme Corp");
    expect(out).toContain("## EXPERIENCE");
    expect(out).toContain("Worked at Acme Corp");
  });

  test("converts bullet glyphs to markdown list items", () => {
    const out = textToMarkdownHeuristic("• Built things\n· Shipped products");
    expect(out).toContain("- Built things");
    expect(out).toContain("- Shipped products");
  });

  test("leaves ordinary prose untouched and collapses blank runs", () => {
    const out = textToMarkdownHeuristic(
      "Jane Doe is a designer.\n\n\n\nShe builds tools.",
    );
    expect(out).toContain("Jane Doe is a designer.");
    expect(out).not.toContain("\n\n\n");
  });

  test("does NOT mis-promote a normal sentence to a heading", () => {
    // Has a period and mixed case → must stay prose, not become "## ...".
    const out = textToMarkdownHeuristic("Led the redesign of a tool.");
    expect(out).not.toContain("## ");
  });
});

describe("bytesToMarkdown — text path", () => {
  test("passes text through, normalizing CRLF and collapsing blank runs", async () => {
    const input = "Jane Doe\r\n\r\n\r\n\r\nSoftware Engineer at Acme Corp";
    const out = await bytesToMarkdown(enc(input), "text");
    expect(out.tier).toBe("L0");
    expect(out.markdown).toContain("Jane Doe");
    expect(out.markdown).toContain("Software Engineer");
    expect(out.markdown).not.toContain("\r");
    expect(out.markdown).not.toContain("\n\n\n");
  });

  test("rejects near-empty content with an actionable ExtractionError", async () => {
    await expect(bytesToMarkdown(enc("   hi   "), "text")).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });
});

describe("bytesToMarkdown — corrupt binary fails cleanly", () => {
  test("garbage docx bytes throw ExtractionError, never crash", async () => {
    await expect(
      bytesToMarkdown(enc("not a real docx package"), "docx"),
    ).rejects.toBeInstanceOf(ExtractionError);
  });
});
