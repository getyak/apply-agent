import { useTranslations } from "next-intl";

/**
 * The hero shows the product itself, not a hand-built facsimile.
 *
 * The animated WebP is assembled from three real Relay sessions: the Vantage
 * workspace, ranked live matches, and the application review surface. People
 * who prefer reduced motion receive the static workspace frame through the
 * <picture> media query.
 */
export default function HeroConsole() {
  const t = useTranslations("landing.heroConsole");
  const stages = [
    t("run.scout.name"),
    t("run.resume.name"),
    t("run.answer.name"),
  ];

  return (
    <figure className="relative m-0 overflow-hidden rounded-[18px] border border-[#d8cdbd] bg-[#f7f2eb] shadow-[0_26px_70px_-30px_rgba(61,42,20,0.52),0_8px_24px_-16px_rgba(61,42,20,0.28)]">
      <div className="flex h-10 items-center border-b border-[#ded5c8] bg-[#f4eee6] px-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.62px] text-brown">
          {t("titleBar")}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.62px] text-green">
          {t("live")}
        </span>
      </div>

      <picture className="block aspect-[8/5] overflow-hidden bg-[#fbfaf8]">
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet="/demo/workspace.png"
        />
        <img
          src="/demo/relay-product-tour.webp"
          alt={`${stages.join(", ")}. ${t("ready.title", { count: 8 })}`}
          width={900}
          height={563}
          loading="eager"
          decoding="async"
          fetchPriority="high"
          className="block h-full w-full object-cover"
        />
      </picture>

      <figcaption className="grid grid-cols-3 border-t border-[#ded5c8] bg-[#f7f2eb]">
        {stages.map((stage, index) => (
          <span
            key={stage}
            className={`min-w-0 px-3 py-2.5 font-mono text-[9px] uppercase tracking-[0.55px] text-[#756a5e] ${
              index > 0 ? "border-l border-[#ded5c8]" : ""
            }`}
          >
            {stage}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
