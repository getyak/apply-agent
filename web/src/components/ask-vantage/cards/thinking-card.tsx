"use client";

/**
 * thinking-card.tsx — provider chain-of-thought (REASONING_MESSAGE_*).
 * Collapsible: header shows a spinner/check + elapsed; body shows the
 * streamed reasoning transcript (deferred under fast streaming).
 *
 * Caller: step-card.tsx. Facts: no data-file IO; reads step.reasoning_text.
 */

import { useDeferredValue, useState } from "react";
import { useTranslations } from "next-intl";
import type { Step } from "@/lib/agent-events";
import { CardFrame, statusColor } from "../step-card";

export function ThinkingCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const running = step.status === "running";
  const [open, setOpen] = useState<boolean>(running);
  const reasoning = useDeferredValue(step.reasoning_text ?? "");

  return (
    <CardFrame testId="step-thinking">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
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
        {running ? (
          <span
            className="animate-spin"
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              border: "2px solid #F0E4D2",
              borderTopColor: "#A66A00",
              flexShrink: 0,
            }}
          />
        ) : (
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: statusColor(step.status),
              flexShrink: 0,
            }}
          />
        )}
        <span className="ds-mono-10" style={{ color: "#5D3000" }}>
          {t("message.thinking")}
        </span>
        {typeof step.duration_ms === "number" ? (
          <span className="ds-mono-9" style={{ marginLeft: "auto", color: "#A39F99" }}>
            {(step.duration_ms / 1000).toFixed(1)}s
          </span>
        ) : null}
      </button>
      {open && reasoning ? (
        <div
          style={{
            borderTop: "1px solid #F0E8DA",
            padding: "10px 14px 12px 38px",
            background: "#FBF8F3",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 12.5,
            lineHeight: 1.55,
            color: "#3D3933",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {reasoning}
        </div>
      ) : null}
    </CardFrame>
  );
}
