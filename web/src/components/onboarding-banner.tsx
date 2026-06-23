"use client";

import { Sparkles, Check, AlertCircle, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useVantage } from "@/lib/store";

// Non-blocking progress banner shown at the top of the workspace while the
// résumé is parsed in the background. This is the visible half of the async
// onboarding change: the user is already working; this just keeps them informed
// and fills in their real name/skills the moment parsing completes.
export function OnboardingBanner() {
  const t = useTranslations("onboarding");
  const status = useVantage((s) => s.parseJobStatus);
  const progress = useVantage((s) => s.parseJobProgress);
  const fileName = useVantage((s) => s.parseFileName);
  const error = useVantage((s) => s.parseJobError);
  const name = useVantage((s) => s.parsedResume?.basics?.name);
  const dismiss = useVantage((s) => s.dismissParseBanner);

  if (status === "idle") return null;

  const running = status === "running";
  const done = status === "done";
  const failed = status === "failed";

  return (
    <div className="animate-fade-up shrink-0 border-b border-border bg-cream">
      <div className="flex items-center gap-3 px-6 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white">
          {running && <Sparkles size={15} strokeWidth={2} className="animate-pulse text-amber" />}
          {done && <Check size={15} strokeWidth={2.5} className="text-green" />}
          {failed && <AlertCircle size={15} strokeWidth={2} className="text-red-500" />}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate font-body text-[13px] text-ink">
            {running &&
              t.rich("banner.running", {
                file: fileName || t("banner.yourResume"),
                strong: (chunks) => <span className="font-medium">{chunks}</span>,
              })}
            {done &&
              t.rich("banner.done", {
                name: name ? t("banner.nameSuffix", { name }) : "",
                strong: (chunks) => <span className="font-medium">{chunks}</span>,
              })}
            {failed && (
              <span className="text-red-700">
                {t("banner.failed", { reason: error || t("banner.failedDefault") })}
              </span>
            )}
          </p>

          {running && (
            <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-amber transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(5, progress)}%` }}
              />
            </div>
          )}
        </div>

        {(done || failed) && (
          <button
            type="button"
            onClick={dismiss}
            aria-label={t("banner.dismiss")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-white hover:text-ink"
          >
            <X size={14} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
