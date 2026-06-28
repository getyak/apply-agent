"use client";

// Top-pinned banner — used for SESSION_EXPIRED, NETWORK_BLOCKED,
// CLIENT_VERSION_STALE and (W5.1) the global health degraded notice.
// Dismissable. Render at most one — the layout-level HealthBanner
// owns its slot; ad-hoc page banners should be rare.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { ResolvedError, Cta } from "@/lib/errors/resolve";
import { emitTelemetry, currentPath } from "@/lib/telemetry";
import { ErrorDetails } from "./ErrorDetails";

interface Props {
  resolved: ResolvedError;
  onCta?: (cta: Cta) => void;
  /**
   * If true (default), the user can close the banner. Pass false for
   * banners that represent active system state (we close on the next
   * 2xx, not on user click).
   */
  dismissable?: boolean;
}

export function ErrorBanner({ resolved, onCta, dismissable = true }: Props) {
  const t = useTranslations();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (resolved.surface === "silent") return;
    emitTelemetry({
      name: "error_shown",
      payload: {
        code: resolved.copyable.code,
        surface: "banner",
        traceId: resolved.copyable.traceId,
        traceCode: resolved.traceCode,
        severity: resolved.severity,
        path: currentPath(),
      },
    });
  }, [resolved.copyable.traceId, resolved.copyable.code, resolved.severity, resolved.surface, resolved.traceCode]);
  if (resolved.surface === "silent" || dismissed) return null;
  const tone =
    resolved.severity === "info"
      ? "bg-cream"
      : "bg-gold-bg";

  return (
    <div
      role="status"
      className={`w-full border-b border-cream-border ${tone} font-body text-[13px]`}
    >
      <div className="max-w-[1200px] mx-auto px-4 py-2 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-ink">
            {t(resolved.titleKey, resolved.bodyVars)}
          </span>
          <span className="ml-2 text-ink-light">
            {t(resolved.bodyKey, resolved.bodyVars)}
          </span>
          <ErrorDetails copyable={resolved.copyable} compact />
        </div>
        <div className="flex items-center gap-3">
          {resolved.ctas.map((cta) => (
            <button
              key={cta.id}
              type="button"
              onClick={() => onCta?.(cta)}
              className="text-brown font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brown rounded text-[12px]"
            >
              {t(cta.labelKey)}
            </button>
          ))}
          {dismissable && (
            <button
              type="button"
              aria-label={t("errors._common.dismiss")}
              onClick={() => setDismissed(true)}
              className="text-ink-muted hover:text-ink p-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brown"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
