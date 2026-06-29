"use client";

/**
 * file-edit-card.tsx — a file edit (relay.file_edit / .preview). Collapsed
 * by default: path + hunk count. Expanding lazy-loads the Monaco diff editor
 * (plan constraint #6) so the dock doesn't pay the ~bundle cost unless the
 * user actually opens a diff.
 *
 * Caller: step-card.tsx (kind === "file_edit").
 * Facts: no data-file IO; reads step.file.{path,language,hunks,applied}.
 */

import { lazy, Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import type { Step } from "@/lib/agent-events";
import { CardFrame, statusColor } from "../step-card";

// Heavy: only pulled into the bundle the first time a user expands a diff.
const DiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
);

export function FileEditCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const [open, setOpen] = useState(false);
  const file = step.file;
  if (!file) return null;

  const before = file.hunks.map((h) => h.before).join("\n");
  const after = file.hunks.map((h) => h.after).join("\n");
  const lineCount = after.split("\n").length;

  return (
    <CardFrame testId="step-file-edit" surface={false}>
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #EDE8DF",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="step-file-edit-toggle"
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              width: 12,
              color: "#A39F99",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform .12s ease-out",
            }}
          >
            ▶
          </span>
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: statusColor(step.status),
              flexShrink: 0,
            }}
          />
          <span
            className="ds-mono-10"
            style={{ color: "#5D3000", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {file.path}
          </span>
          <span className="ds-mono-9" style={{ color: "#A39F99", flexShrink: 0 }}>
            {t("fileEdit.lines", { count: lineCount })}
          </span>
          {file.applied ? (
            <span
              className="ds-mono-9"
              style={{ color: "#2F5722", background: "#E2EED9", padding: "2px 7px", borderRadius: 999, flexShrink: 0 }}
            >
              {t("fileEdit.applied")}
            </span>
          ) : (
            <span
              className="ds-mono-9"
              style={{ color: "#8A6A12", background: "#FBEFD0", padding: "2px 7px", borderRadius: 999, flexShrink: 0 }}
            >
              {t("fileEdit.preview")}
            </span>
          )}
        </button>
        {open ? (
          <div style={{ borderTop: "1px solid #F0E8DA", height: 240 }}>
            <Suspense
              fallback={
                <div
                  className="ds-mono-9"
                  style={{ padding: 12, color: "#A39F99" }}
                >
                  {t("fileEdit.loadingDiff")}
                </div>
              }
            >
              <DiffEditor
                height="240px"
                language={file.language}
                original={before}
                modified={after}
                theme="light"
                options={{
                  readOnly: true,
                  renderSideBySide: false,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                }}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
    </CardFrame>
  );
}
