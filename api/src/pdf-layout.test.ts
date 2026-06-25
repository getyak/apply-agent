import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import { pdfItemsToMarkdown } from "./pdf-layout";

// The real résumé fixture is local-only (git-ignored — it holds PII). These
// tests run against it when present and are skipped in CI where it's absent, so
// they document & lock the layout-aware wins without committing the PDF.
const FIXTURE = `${import.meta.dir}/../../test-fixtures/resumes/sample-resume.pdf`;
const hasFixture = existsSync(FIXTURE);

describe.if(hasFixture)("pdfItemsToMarkdown — layout-aware (sample résumé)", () => {
  let md = "";
  let rawText = "";

  beforeAll(async () => {
    const bytes = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
    md = await pdfItemsToMarkdown(await getDocumentProxy(new Uint8Array(bytes)));
    const pdf2 = await getDocumentProxy(new Uint8Array(bytes));
    rawText = (await extractText(pdf2, { mergePages: true })).text as string;
  }, 30_000);

  test("converts the fixture into structured Markdown", () => {
    expect(md.length).toBeGreaterThan(1000);
  });

  test("recovers section headings (## ) — language-neutral, not ALL-CAPS-only", () => {
    expect(md).toMatch(/^## /m);
    expect(md).toContain("## 基础信息");
    expect(md).toContain("## 工作经历");
  });

  test("reconstructs the work-history table as a real Markdown table", () => {
    expect(md).toContain("| --- |");
    // a row with date + company + role joined by pipes
    expect(md).toMatch(/\| 2014\.07.*中天科技集团.*工艺员.*\|/);
  });

  test("renders even a short 2-row table (education) with a |---| separator", () => {
    // 教育经历 is a header + 1 data row; it must still be a real Markdown table,
    // not bare pipe-separated text.
    expect(md).toContain("| 时间 | 学校 | 专业 |");
    expect(md).toMatch(/\| 时间 \| 学校 \| 专业 \|\n\| --- \| --- \| --- \|/);
  });

  test("re-joins words split across a soft wrap (no mid-word break)", () => {
    expect(md).toContain("内存占比"); // "内存占" + "比" glued back
    expect(md).not.toContain("内存占\n");
  });

  test("bolds résumé field labels into list items", () => {
    expect(md).toContain("- **姓名:** 王祥");
    expect(md).toContain("- **电话:**");
  });

  test("does NOT fabricate content — nothing appears that wasn't in the PDF", () => {
    // The no-fabrication red line (vision.md): the converter may DROP intended
    // noise (nav crumb, download button, "1." ordered-list markers it turns into
    // "-"), but must never ADD a character that isn't in the source text.
    const counts = (s: string) => {
      const m = new Map<string, number>();
      for (const c of s.match(/[一-龥A-Za-z0-9]/g) ?? []) m.set(c, (m.get(c) ?? 0) + 1);
      return m;
    };
    const mc = counts(md);
    const rc = counts(rawText);
    const fabricated: string[] = [];
    for (const [c, n] of mc) if (n > (rc.get(c) ?? 0)) fabricated.push(c);
    expect(fabricated).toEqual([]);
  });
});
