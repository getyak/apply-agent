"use client";

// Inline error — sits underneath a form field or inside a chat bubble.
// Quiet by design: no big "Error" word, just the body line and a tiny
// reference. The Auth page uses this to render AUTH_INVALID_CREDENTIALS
// next to the password field. The dock uses it inside the assistant
// bubble for LLM errors so the conversation flow isn't broken by a
// toast popup.

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import type { ResolvedError, Cta } from "@/lib/errors/resolve";
import { emitTelemetry, currentPath } from "@/lib/telemetry";
import { ErrorDetails } from "./ErrorDetails";

interface Props {
  resolved: ResolvedError;
  /** Caller handles CTA clicks. We expose ids so the matrix stays the
   * single source of truth for what "retry" / "reauth" mean. */
  onCta?: (cta: Cta) => void;
  /** Hide the reference + copy block (e.g. very tight inline contexts). */
  hideDetails?: boolean;
}

export function ErrorInline({ resolved, onCta, hideDetails }: Props) {
  const t = useTranslations();
  // One emission per logical error instance — re-running resolveError
  // produces a fresh ResolvedError object, so traceId is the natural
  // dedupe key for re-renders that don't represent new failures.
  useEffect(() => {
    if (resolved.surface === "silent") return;
    emitTelemetry({
      name: "error_shown",
      payload: {
        code: resolved.copyable.code,
        surface: "inline",
        traceId: resolved.copyable.traceId,
        traceCode: resolved.traceCode,
        severity: resolved.severity,
        path: currentPath(),
      },
    });
  }, [resolved.copyable.traceId, resolved.copyable.code, resolved.severity, resolved.surface, resolved.traceCode]);
  if (resolved.surface === "silent") return null;
  const severityClasses =
    resolved.severity === "error" || resolved.severity === "critical"
      ? "text-amber bg-gold-bg border-cream-border"
      : "text-amber bg-gold-bg border-cream-border";

  return (
    <div
      role="alert"
      className={`font-body text-[13px] ${severityClasses} border rounded-[10px] px-3 py-2`}
    >
      <div className="font-medium">
        {t(resolved.titleKey, resolved.bodyVars)}
      </div>
      <div className="mt-0.5 text-ink-light">
        {t(resolved.bodyKey, resolved.bodyVars)}
      </div>
      {resolved.ctas.length > 0 && (
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          {resolved.ctas.map((cta) => (
            <button
              key={cta.id}
              type="button"
              onClick={() => {
                emitTelemetry({
                  name: "error_cta_clicked",
                  payload: {
                    ctaId: cta.id,
                    code: resolved.copyable.code,
                    traceId: resolved.copyable.traceId,
                    path: currentPath(),
                  },
                });
                onCta?.(cta);
              }}
              className="text-brown font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brown rounded text-[12px]"
            >
              {t(cta.labelKey)}
            </button>
          ))}
        </div>
      )}
      {!hideDetails && <ErrorDetails copyable={resolved.copyable} compact />}
    </div>
  );
}
