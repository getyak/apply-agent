"use client";

// Shared sub-component: the "Reference: R-XXXX" line + collapsible
// detail panel + "Copy details" button. Mounted inside every other
// error presentation (Inline / Toast / Banner / FullPage) so the
// support-facing copy is identical wherever the error shows up.

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ResolvedError } from "@/lib/errors/resolve";
import { emitTelemetry, currentPath } from "@/lib/telemetry";

interface Props {
  copyable: ResolvedError["copyable"];
  // The renderer can suppress the reference line entirely (e.g. inline
  // form errors next to a single field — too noisy). Defaults to true.
  showReference?: boolean;
  // Smaller density for inline contexts.
  compact?: boolean;
}

/**
 * Build the markdown the "Copy details" button writes to clipboard.
 * Stable shape so the user can paste it into Slack / email / GitHub
 * issue and the support agent gets a parseable block every time.
 */
function copyMarkdown(c: ResolvedError["copyable"]): string {
  const lines: string[] = [];
  lines.push("**Relay error report**");
  if (c.code) lines.push(`Code: \`${c.code}\``);
  if (c.traceCode) lines.push(`Reference: \`${c.traceCode}\``);
  if (c.traceId) lines.push(`Trace ID: \`${c.traceId}\``);
  if (c.requestId) lines.push(`Request ID: \`${c.requestId}\``);
  if (c.timestamp) lines.push(`Time: ${c.timestamp}`);
  return lines.join("\n");
}

export function ErrorDetails({ copyable, showReference = true, compact }: Props) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasAny =
    copyable.code || copyable.traceCode || copyable.traceId || copyable.requestId;
  if (!hasAny) return null;

  const handleCopy = async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      await navigator.clipboard.writeText(copyMarkdown(copyable));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      // Copy is the strongest signal a user has reached for support —
      // log it so we can prioritise the codes people are stuck on.
      emitTelemetry({
        name: "error_details_copied",
        payload: {
          code: copyable.code,
          traceId: copyable.traceId,
          traceCode: copyable.traceCode,
          path: currentPath(),
        },
      });
    } catch {
      // Clipboard API gated by permissions / non-HTTPS — silently fail;
      // the user can still read the visible reference text.
    }
  };

  const size = compact ? "text-[11px]" : "text-[12px]";

  return (
    <div className={`mt-2 font-mono ${size} text-ink-muted`}>
      <div className="flex items-center gap-2 flex-wrap">
        {showReference && copyable.traceCode && (
          <span>
            {t("errors._common.referenceLabel")}:{" "}
            <span className="text-ink">{copyable.traceCode}</span>
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="underline hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brown rounded"
        >
          {copied
            ? t("errors._common.copied")
            : t("errors._common.copyDetails")}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="underline hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brown rounded"
          aria-expanded={expanded}
        >
          {expanded ? t("errors._common.hideDetails") : t("errors._common.showDetails")}
        </button>
      </div>
      {expanded && (
        <pre className="mt-1 px-2 py-1 bg-cream border border-cream-border rounded-[6px] overflow-x-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed">
          {copyMarkdown(copyable)}
        </pre>
      )}
    </div>
  );
}
