"use client";

/**
 * tool-card.tsx — a tool call (TOOL_CALL_*) or an agent step
 * (relay.agent_start/done; the reducer models those as tool steps too).
 * Collapsed by default: name · status · duration. Expand for input/output.
 *
 * Caller: step-card.tsx. Facts: no data-file IO; reads step.tool.{name,args,result}.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { Step } from "@/lib/agent-events";
import { CardFrame, statusColor } from "../step-card";

const PREVIEW_LINES = 200;

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const t = useTranslations("dock");
  const [expanded, setExpanded] = useState(false);
  const pretty = useMemo(() => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const lines = pretty.split("\n");
  const overflowing = lines.length > PREVIEW_LINES;
  const visible =
    overflowing && !expanded ? lines.slice(0, PREVIEW_LINES).join("\n") : pretty;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="ds-mono-9" style={{ color: "#A39F99" }}>
        {label}
      </div>
      <pre
        style={{
          margin: 0,
          background: "#FFFFFF",
          border: "1px solid #F0E8DA",
          borderRadius: 6,
          padding: "8px 10px",
          maxHeight: 220,
          overflow: "auto",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          fontSize: 11.5,
          lineHeight: 1.5,
          color: "#2B2822",
          whiteSpace: "pre",
        }}
      >
        {visible}
        {overflowing && !expanded
          ? `\n…${t("tool.moreLines", { count: lines.length - PREVIEW_LINES })}`
          : ""}
      </pre>
      {overflowing ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ds-mono-9"
          style={{
            all: "unset",
            cursor: "pointer",
            color: "#5D3000",
            alignSelf: "flex-start",
          }}
        >
          {expanded ? t("tool.showLess") : t("tool.showAll")}
        </button>
      ) : null}
    </div>
  );
}

export function ToolCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const [open, setOpen] = useState(false);
  const running = step.status === "running";
  const name = step.tool?.name ?? step.title;
  const hasArgs = step.tool?.args !== undefined && step.tool?.args !== "";
  const hasResult = step.tool?.result !== undefined;

  return (
    <CardFrame testId="step-tool" surface={false}>
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
          data-testid="step-tool-toggle"
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
          {running ? (
            <span
              className="animate-spin"
              style={{
                width: 13,
                height: 13,
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
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: 999,
                background: statusColor(step.status),
                flexShrink: 0,
              }}
            />
          )}
          <span className="ds-mono-10" style={{ color: "#5D3000", flexShrink: 0 }}>
            {name}
          </span>
          <span style={{ flex: 1 }} />
          <span
            className="ds-mono-9"
            data-testid="step-tool-status"
            style={{ color: statusColor(step.status), flexShrink: 0 }}
          >
            {running
              ? t("taskGraph.running")
              : step.status === "failed"
                ? t("tool.failed")
                : t("tool.ok")}
          </span>
          {typeof step.duration_ms === "number" ? (
            <span className="ds-mono-9" style={{ color: "#A39F99", marginLeft: 6 }}>
              {(step.duration_ms / 1000).toFixed(1)}s
            </span>
          ) : null}
        </button>
        {open ? (
          <div
            style={{
              borderTop: "1px solid #F0E8DA",
              padding: "10px 14px 12px 38px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              background: "#FBF8F3",
            }}
          >
            {hasArgs ? <JsonBlock label={t("tool.input")} value={step.tool?.args} /> : null}
            {hasResult ? (
              <JsonBlock label={t("tool.output")} value={step.tool?.result} />
            ) : null}
            {!hasArgs && !hasResult ? (
              <div className="ds-mono-9" style={{ color: "#A39F99" }}>
                {running ? t("taskGraph.running") : t("tool.ok")}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </CardFrame>
  );
}
