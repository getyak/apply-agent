"use client";

/**
 * artifact-card.tsx — a finished artifact (relay.artifact). Renders a title
 * + a compact preview of the snapshot payload (items list or text). The
 * full structured artifact (suggestion stacks, evidence, actions) is left
 * to the destination surface; the dock card is a glanceable summary.
 *
 * Caller: step-card.tsx (kind === "artifact", status done).
 * Facts: no data-file IO; reads step.artifact.snapshot.
 */

import type { Step } from "@/lib/agent-events";
import { CardFrame } from "../step-card";

function previewLines(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object") {
    return typeof snapshot === "string" ? [snapshot] : [];
  }
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
  if (typeof obj.sub === "string") return [obj.sub];
  return [];
}

export function ArtifactCard({ step }: { step: Step }) {
  const items = previewLines(step.artifact?.snapshot);
  return (
    <CardFrame testId="step-artifact" surface={false}>
      <div
        style={{
          background: "#FFFBF4",
          border: "1px solid #E8DCCA",
          borderRadius: 12,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 9.5,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "#A39F99",
          }}
        >
          {step.artifact?.id ? `artifact · ${step.artifact.id}` : "artifact"}
        </div>
        <div
          style={{
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 600,
            fontSize: 14,
            color: "#2B2822",
          }}
        >
          {step.title}
        </div>
        {items.length > 0 ? (
          <ul
            data-testid="step-artifact-items"
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
