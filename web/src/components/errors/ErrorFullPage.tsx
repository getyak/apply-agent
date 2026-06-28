"use client";

// Full-page error — used by app/error.tsx (route boundary) and the
// onboarding flow when the upload is unrecoverable. Centered card,
// Relay logo, big title + body, two CTAs (primary retry, secondary
// home), and an always-visible Reference strip. This is the only
// surface where we DON'T auto-dismiss; the user must take a CTA.

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ResolvedError, Cta } from "@/lib/errors/resolve";
import { Button } from "@/components/ui";
import { emitTelemetry, currentPath } from "@/lib/telemetry";
import { ErrorDetails } from "./ErrorDetails";

interface Props {
  resolved: ResolvedError;
  onCta?: (cta: Cta) => void;
  /** Where the "Back to Today" link goes. */
  homeHref?: string;
}

export function ErrorFullPage({
  resolved,
  onCta,
  homeHref = "/app/today",
}: Props) {
  const t = useTranslations();
  useEffect(() => {
    emitTelemetry({
      name: "error_shown",
      payload: {
        code: resolved.copyable.code,
        surface: "full-page",
        traceId: resolved.copyable.traceId,
        traceCode: resolved.traceCode,
        severity: resolved.severity,
        path: currentPath(),
      },
    });
  }, [resolved.copyable.traceId, resolved.copyable.code, resolved.severity, resolved.traceCode]);
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <div className="font-display text-[18px] font-bold tracking-[3px] mb-6">
          <span className="gradient-text">VANTAGE</span>
        </div>
        <h1 className="font-display text-[28px] font-bold -tracking-[0.3px] text-ink leading-tight">
          {t(resolved.titleKey, resolved.bodyVars)}
        </h1>
        <p className="mt-3 font-body text-[15px] text-ink-light">
          {t(resolved.bodyKey, resolved.bodyVars)}
        </p>
        {resolved.ctas.length > 0 && (
          <div className="mt-6 flex items-center justify-center gap-3 flex-wrap">
            {resolved.ctas.map((cta, i) => (
              <Button
                key={cta.id}
                onClick={() => onCta?.(cta)}
                variant={i === 0 ? undefined : "secondary"}
                size="md"
              >
                {t(cta.labelKey)}
              </Button>
            ))}
          </div>
        )}
        <div className="mt-6">
          <ErrorDetails copyable={resolved.copyable} />
        </div>
        <p className="mt-8 font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
          <Link
            href={homeHref}
            className="inline-flex items-center gap-1 hover:text-ink transition-colors"
          >
            <ArrowLeft size={11} /> {t("errors._common.backHome")}
          </Link>
        </p>
      </div>
    </div>
  );
}
