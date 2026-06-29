"use client";

/**
 * narrator-card.tsx — italic "thought-aloud" chip (relay.narrator). A quiet
 * single line, no avatar/bubble, so the dock log still reads as a
 * conversation. One per discrete tool invocation.
 *
 * Caller: step-card.tsx. Facts: no data-file IO; reads step.narrator.text.
 */

import type { Step } from "@/lib/agent-events";

export function NarratorCard({ step }: { step: Step }) {
  const text = (step.narrator?.text ?? "").trim();
  if (!text) return null;
  return (
    <div
      data-testid="step-narrator"
      className="animate-pop"
      style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
    >
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          color: "#7C7367",
          fontFamily: "Inter, system-ui, sans-serif",
          fontStyle: "italic",
          fontSize: 12.5,
          lineHeight: 1.45,
          padding: "0 2px",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 5,
            height: 5,
            borderRadius: 999,
            background: "#C9A06A",
            marginTop: 7,
            flexShrink: 0,
          }}
        />
        <span style={{ wordBreak: "break-word" }}>{text}</span>
      </div>
    </div>
  );
}
