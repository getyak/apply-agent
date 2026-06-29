"use client";

/**
 * partial-artifact-card.tsx — a live, in-progress artifact preview
 * (relay.partial_artifact, or a still-streaming relay.artifact step). Shows
 * a pulse + title + a small payload preview so the user sees bullets / cover
 * paragraphs appearing live before the final artifact lands.
 *
 * Caller: step-card.tsx (kind === "artifact", status running).
 * Facts: no data-file IO; reads step.artifact.snapshot.
 */

import { useTranslations } from "next-intl";
import type { Step } from "@/lib/agent-events";
import { CardFrame } from "../step-card";

function previewLines(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const obj = snapshot as Record<string, unknown>;
  if (Array.isArray(obj.items)) {
    return obj.items
      .slice(0, 5)
      .map((it) => (typeof it === "string" ? it : JSON.stringify(it)))
      .map((s) => (s.length > 200 ? s.slice(0, 200) + "…" : s));
  }
  if (typeof obj.text === "string") {
    const tt = obj.text;
    return [tt.length > 280 ? tt.slice(0, 280) + "…" : tt];
  }
  return [];
}

export function PartialArtifactCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const items = previewLines(step.artifact?.snapshot);
  return (
    <CardFrame testId="step-partial-artifact" surface={false}>
      <div
        style={{
          background: "#FBF8F3",
          border: "1px dashed #C9A06A",
          borderRadius: 12,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden
            className="animate-pulse"
            style={{
              display: "inline-block",
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "#C9A06A",
            }}
          />
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 13.5,
              color: "#5D3000",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.title || t("partial.drafting")}
          </div>
        </div>
        {items.length > 0 ? (
          <ul
            data-testid="step-partial-artifact-items"
            style={{
              margin: 0,
              padding: "0 0 0 18px",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12.5,
              color: "#3D3933",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {items.map((it, idx) => (
              <li key={idx} style={{ lineHeight: 1.45 }}>
                {it}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </CardFrame>
  );
}
