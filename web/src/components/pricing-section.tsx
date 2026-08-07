"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

function FeatureList({
  features,
  inverse = false,
}: {
  features: string[];
  inverse?: boolean;
}) {
  return (
    <div className="grid gap-3">
      {features.map((feature) => (
        <div
          key={feature}
          className={`flex gap-2.5 text-[14px] leading-[1.45] ${
            inverse
              ? "text-[var(--landing-on-contrast-muted)]"
              : "text-[var(--landing-muted)]"
          }`}
        >
          <Check
            size={15}
            strokeWidth={2}
            aria-hidden
            className={`mt-0.5 shrink-0 ${
              inverse
                ? "text-[var(--landing-on-contrast)]"
                : "text-[var(--landing-accent)]"
            }`}
          />
          <span>{feature}</span>
        </div>
      ))}
    </div>
  );
}

export default function PricingSection() {
  const t = useTranslations("landing.pricing");
  const [annual, setAnnual] = useState(true);
  const freeFeatures = t.raw("free.features") as string[];
  const proFeatures = t.raw("pro.features") as string[];
  const maxFeatures = t.raw("max.features") as string[];
  const proPrice = annual ? "19" : "24";
  const maxPrice = annual ? "39" : "49";
  const period = annual ? t("periodAnnual") : t("periodMonthly");

  return (
    <section
      id="pricing"
      className="border-t border-[var(--landing-line)] bg-[var(--landing-surface)]"
    >
      <div className="mx-auto max-w-[1320px] px-5 py-24 sm:px-8 md:py-32">
        <div className="grid items-end gap-7 md:grid-cols-[1fr_auto]">
          <h2 className="m-0 max-w-[760px] text-balance font-display text-[clamp(2.7rem,5vw,4.8rem)] font-bold leading-[0.96] tracking-[-0.055em]">
            {t("title")}
          </h2>
          <div
            role="group"
            aria-label={t("eyebrow")}
            className="flex w-fit rounded-[9px] border border-[var(--landing-line-strong)] bg-[var(--landing-bg)] p-1"
          >
            <button
              type="button"
              aria-pressed={!annual}
              onClick={() => setAnnual(false)}
              className={`min-h-11 cursor-pointer rounded-[6px] border-0 px-4 text-[13px] font-semibold transition-colors duration-200 ${
                annual
                  ? "bg-transparent text-[var(--landing-muted)]"
                  : "bg-[var(--landing-ink)] text-[var(--landing-bg)]"
              }`}
            >
              {t("toggleMonthly")}
            </button>
            <button
              type="button"
              aria-pressed={annual}
              onClick={() => setAnnual(true)}
              className={`min-h-11 cursor-pointer rounded-[6px] border-0 px-4 text-[13px] font-semibold transition-colors duration-200 ${
                annual
                  ? "bg-[var(--landing-ink)] text-[var(--landing-bg)]"
                  : "bg-transparent text-[var(--landing-muted)]"
              }`}
            >
              {t("toggleAnnual")}
            </button>
          </div>
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
          <article className="flex min-h-[520px] flex-col rounded-[var(--landing-frame-radius)] bg-[var(--landing-contrast)] p-7 text-[var(--landing-on-contrast)] sm:p-10">
            <p className="m-0 text-[12px] font-bold uppercase tracking-[0.12em] text-[var(--landing-on-contrast-muted)]">
              {t("pro.badge")}
            </p>
            <div className="mt-7 grid gap-7 sm:grid-cols-[1fr_auto] sm:items-start">
              <div>
                <h3 className="m-0 font-display text-[34px] font-semibold tracking-[-0.035em]">
                  {t("pro.name")}
                </h3>
                <p className="mb-0 mt-2 text-[15px] text-[var(--landing-on-contrast-muted)]">
                  {t("pro.tagline")}
                </p>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="font-display text-[58px] font-bold leading-none tracking-[-0.055em]">
                  ${proPrice}
                </span>
                <span className="max-w-[92px] text-[12px] leading-[1.4] text-[var(--landing-on-contrast-muted)]">
                  {period}
                </span>
              </div>
            </div>
            <div className="mt-10 max-w-[600px] sm:columns-2 sm:gap-10">
              <FeatureList features={proFeatures} inverse />
            </div>
            <a
              href="/auth?plan=pro"
              className="mt-auto inline-flex min-h-12 w-fit items-center justify-center rounded-[8px] bg-[var(--landing-on-contrast)] px-5 text-[14px] font-semibold text-[var(--landing-contrast)] no-underline transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-px"
            >
              {t("pro.cta")}
            </a>
          </article>

          <div className="grid gap-5">
            <article className="rounded-[var(--landing-frame-radius)] border border-[var(--landing-line-strong)] bg-[var(--landing-bg)] p-7">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <h3 className="m-0 font-display text-[25px] font-semibold tracking-[-0.025em]">
                    {t("free.name")}
                  </h3>
                  <p className="mb-0 mt-1.5 text-[13px] text-[var(--landing-muted)]">
                    {t("free.tagline")}
                  </p>
                </div>
                <div className="text-right">
                  <span className="font-display text-[38px] font-bold tracking-[-0.045em]">
                    $0
                  </span>
                  <span className="ml-1 text-[12px] text-[var(--landing-subtle)]">
                    {t("free.period")}
                  </span>
                </div>
              </div>
              <div className="mt-6">
                <FeatureList features={freeFeatures} />
              </div>
              <a
                href="/auth?plan=free"
                className="evidence-button evidence-button-secondary mt-7 min-h-11 px-4 text-[13px]"
              >
                {t("free.cta")}
              </a>
            </article>

            <article className="rounded-[var(--landing-frame-radius)] border border-[var(--landing-line-strong)] bg-[var(--landing-bg)] p-7">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <h3 className="m-0 font-display text-[25px] font-semibold tracking-[-0.025em]">
                    {t("max.name")}
                  </h3>
                  <p className="mb-0 mt-1.5 text-[13px] text-[var(--landing-muted)]">
                    {t("max.tagline")}
                  </p>
                </div>
                <div className="text-right">
                  <span className="font-display text-[38px] font-bold tracking-[-0.045em]">
                    ${maxPrice}
                  </span>
                  <span className="ml-1 text-[12px] text-[var(--landing-subtle)]">
                    {period}
                  </span>
                </div>
              </div>
              <div className="mt-6">
                <FeatureList features={maxFeatures} />
              </div>
              <a
                href="/auth?plan=max"
                className="evidence-button evidence-button-primary mt-7 min-h-11 px-4 text-[13px]"
              >
                {t("max.cta")}
              </a>
            </article>
          </div>
        </div>

        <p className="mb-0 mt-7 max-w-[760px] text-[13px] leading-[1.55] text-[var(--landing-subtle)]">
          {t("footnote")}
        </p>
      </div>
    </section>
  );
}
