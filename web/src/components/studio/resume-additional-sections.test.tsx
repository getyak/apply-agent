import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { ResumeAdditionalSections } from "./resume-additional-sections";
import { EditableDocumentPane } from "./editable-document-pane";
import { DocumentPane } from "../screens/resume-view";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";

const doc = {
  projects: [{ name: "Parser project", description: "Detailed description", highlights: ["First outcome", "Second outcome"], url: "https://example.org/project" }],
  certificates: [{ name: "Certificate name", issuer: "Certificate issuer", url: "https://example.org/certificate", details: { courses: ["Nested course"] } }],
  languages: { name: "Chinese", fluency: "Native" },
  customSection: "Standalone content",
  _raw: "Private raw metadata",
  _warnings: ["Private warning metadata"],
};
const render = (node: ReactNode, locale = "en") => renderToStaticMarkup(
  <NextIntlClientProvider timeZone="UTC" locale={locale} messages={locale === "en" ? en : zh}>{node}</NextIntlClientProvider>,
);
const assertContent = (html: string) => {
  for (const text of ["Parser project", "Detailed description", "First outcome", "Second outcome", "https://example.org/project", "Certificate name", "Certificate issuer", "https://example.org/certificate", "Nested course", "Chinese", "Native", "Standalone content"]) expect(html).toContain(text);
  expect(html).not.toContain("Private raw metadata");
  expect(html).not.toContain("Private warning metadata");
  expect(html.match(/Parser project/g)?.length).toBe(1);
};

describe("resume additional sections", () => {
  test("shows all extension values and nested arrays, without rendering metadata or duplicates", () => {
    assertContent(render(<ResumeAdditionalSections doc={doc} omit={["basics", "work"]} />));
  });
  test("uses Chinese section labels", () => {
    const html = render(<ResumeAdditionalSections doc={doc} omit={[]} />, "zh");
    expect(html).toContain("项目");
    expect(html).toContain("证书");
  });
  test("project-only structured document stays visible instead of falling back to raw text", () => {
    const html = render(<DocumentPane basics={{}} contact="" work={[]} skills={[]} education={[]} fullDoc={doc}
      rawText="Fallback text must not replace projects" markdown={null} presentation="original" suggestions={[]}
      viewMode="document" showAITouchedLabel={false} compareOn={false} baseDoc={null} baseDocLoading={false} baseVersionLabel={null} />);
    assertContent(html);
    expect(html).not.toContain("Fallback text must not replace projects");
  });
  test("optimized editor also exposes projects, extensions, skills and education", () => {
    const html = render(<EditableDocumentPane resumeId="synthetic-resume" baseVersion={1} initialDoc={{ ...doc,
      skills: [{ name: "TypeScript" }], education: [{ institution: "Example University" }] }} />);
    assertContent(html);
    expect(html).toContain("TypeScript");
    expect(html).toContain("Example University");
  });
});
