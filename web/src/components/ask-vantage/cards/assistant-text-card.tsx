"use client";

/**
 * assistant-text-card.tsx — Vantage's streamed reply (TEXT_MESSAGE_*).
 * Renders markdown; shows a streaming cursor while the step is running and a
 * "Thinking" placeholder before the first token.
 *
 * Perf (plan constraint #4): the streamed `text` is passed through
 * useDeferredValue so a 100 tok/s stream commits at most ~1 paint per
 * frame instead of re-rendering the whole markdown tree on every delta.
 *
 * Caller: step-card.tsx. Facts: no data-file IO; reads step.text/status.
 */

import { useDeferredValue } from "react";
import { useTranslations } from "next-intl";
import type { Step } from "@/lib/agent-events";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { StreamingCursor } from "@/components/chat/streaming-cursor";

function VantageMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#FAF8F6"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 2.5l1.7 4.6 4.9.2-3.8 3 1.3 4.7-4-2.8-4 2.8 1.3-4.7-3.8-3 4.9-.2z" />
    </svg>
  );
}

export function AssistantTextCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const running = step.status === "running";
  // Defer the heavy markdown render under fast streaming.
  const text = useDeferredValue(step.text ?? "");

  // An empty bubble while streaming is just noise — the thinking/narrator
  // steps already signal "working". Hide until the first token lands.
  if (!text && running) return null;

  return (
    <div
      data-testid="step-assistant-text"
      style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: "#5D3000",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <VantageMark />
      </div>
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #EDE8DF",
          color: "#2B2822",
          padding: "10px 14px",
          borderRadius: 14,
          minWidth: 0,
          flex: 1,
        }}
      >
        {text ? (
          <MarkdownMessage content={text} />
        ) : (
          <span
            style={{
              color: "#7C7367",
              fontFamily: "Inter, system-ui, sans-serif",
              fontStyle: "italic",
              fontSize: 13,
            }}
          >
            {t("message.thinking")}
          </span>
        )}
        {running ? <StreamingCursor /> : null}
      </div>
    </div>
  );
}
