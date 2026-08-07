import { useTranslations } from "next-intl";

/**
 * The hero uses a recording assembled from real Vantage product sessions.
 * Reduced-motion visitors receive a still frame from the same product.
 */
export default function HeroConsole() {
  const t = useTranslations("landing.heroConsole");
  const stages = [
    t("run.scout.name"),
    t("run.resume.name"),
    t("run.answer.name"),
  ];

  return (
    <figure className="m-0">
      <picture className="block aspect-[8/5] overflow-hidden rounded-[var(--landing-frame-radius)] border border-[var(--landing-line-strong)] bg-[var(--landing-surface)] shadow-[var(--landing-shadow)]">
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet="/demo/workspace.png"
        />
        <img
          src="/demo/relay-product-tour.webp"
          alt={t("productAlt", { agents: stages.join(", ") })}
          width={1200}
          height={750}
          loading="eager"
          decoding="async"
          fetchPriority="high"
          className="block h-full w-full object-cover"
        />
      </picture>
      <figcaption className="mt-3 flex flex-wrap justify-between gap-x-6 gap-y-1 text-[12px] text-[var(--landing-subtle)]">
        <span>{t("proofLabel")}</span>
        <span>{t("proofDetail")}</span>
      </figcaption>
    </figure>
  );
}
