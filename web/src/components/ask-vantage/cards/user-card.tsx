"use client";

/**
 * user-card.tsx — the user's own prompt bubble (right-aligned). The store
 * injects a "user" step via pushUserStep; the reducer never produces it.
 *
 * Caller: step-card.tsx (kind === "user" branch).
 * Facts: no data-file IO; renders step.text only.
 */

import type { Step } from "@/lib/agent-events";

export function UserCard({ step }: { step: Step }) {
  return (
    <div
      data-msg-id={step.id}
      data-testid="step-user"
      style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}
    >
      <div
        style={{
          maxWidth: 280,
          background: "#5D3000",
          color: "#FAF8F6",
          padding: "10px 14px",
          borderRadius: 14,
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 13.5,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {step.text}
      </div>
    </div>
  );
}
