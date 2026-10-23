"use client";

import { useTranslations } from "next-intl";

/** Preserve every visible leaf, including nested extension objects and arrays. */
function lines(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(lines);
  if (value && typeof value === "object") {
    return Object.entries(value).filter(([key]) => !key.startsWith("_")).flatMap(([, item]) => lines(item));
  }
  return [];
}

export function additionalResumeSections(doc: Record<string, unknown> | null, omit: string[]) {
  return Object.entries(doc ?? {})
    .filter(([key]) => !key.startsWith("_") && !omit.includes(key))
    .map(([key, value]) => ({ key, lines: lines(value) }))
    .filter((section) => section.lines.length > 0);
}

const LABELLED_KEYS = new Set([
  "projects", "skills", "education", "awards", "certificates", "publications",
  "languages", "volunteer", "interests", "references",
]);

/** Read-only sections alongside the existing editor; saving preserves their JSON. */
export function ResumeAdditionalSections({ doc, omit }: {
  doc: Record<string, unknown> | null;
  omit: string[];
}) {
  const t = useTranslations("resume");
  return additionalResumeSections(doc, omit).map(({ key, lines: content }) => (
    <section key={key} data-resume-section={key} style={{ marginTop: 24, marginBottom: 18 }}>
      <h2 className="ds-mono-10" style={{ margin: "0 0 12px", color: "#6B6560" }}>
        {LABELLED_KEYS.has(key) ? t(`doc.sections.${key}`) : key.replace(/[-_]/g, " ")}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {content.map((line, i) => (
          <div key={i} className="ds-body-sm" style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {line}
          </div>
        ))}
      </div>
    </section>
  ));
}
