import { ArrowRight, Check } from "lucide-react";
import Image from "next/image";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import HeroConsole from "@/components/hero-console";
import PricingSection from "@/components/pricing-section";
import ProductJourney, {
  type ProductJourneyCopy,
} from "@/components/product-journey";
import { LandingAccountChip } from "@/components/landing-account-chip";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { SITE_NAME, SITE_TAGLINE, SITE_URL, SOCIAL_LINKS } from "@/lib/site";

const TOKEN_COOKIE = "vantage_token";

type EvidenceItem = {
  title: string;
  body: string;
};

type FeatureItem = {
  title: string;
  body: string;
};

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("landing");
  const params = (await searchParams) ?? {};
  const contract = t.raw("evidence.contract") as EvidenceItem[];
  const asks = t.raw("chat.asks") as string[];
  const features = t.raw("features.items") as FeatureItem[];
  const principles = t.raw("bets.items") as EvidenceItem[];
  const faqItems = t.raw("faq.items") as { q: string; a: string }[];
  const journeyScenes = t.raw(
    "journey.scenes",
  ) as ProductJourneyCopy["scenes"];
  const journey: ProductJourneyCopy = {
    eyebrow: t("journey.eyebrow"),
    title: t("journey.title"),
    subtitle: t("journey.subtitle"),
    scenes: journeyScenes,
  };

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_URL,
      logo: `${SITE_URL}/icon.svg`,
      description: t("hero.subhead"),
      sameAs: SOCIAL_LINKS,
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: SITE_URL,
      inLanguage: ["en", "zh-CN"],
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, Chrome Extension",
      description: SITE_TAGLINE,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqItems.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ];

  const isSignedIn = Boolean((await cookies()).get(TOKEN_COOKIE)?.value);
  const primaryCtaHref = isSignedIn ? "/app" : "/auth";
  const primaryCtaLabel = isSignedIn
    ? t("nav.openWorkspace")
    : t("nav.startFree");
  const showRedirectNotice =
    !isSignedIn && params.source === "app_redirect";
  const featureColumns = [features.slice(0, 3), features.slice(3)];

  return (
    <div className="evidence-landing min-h-screen bg-[var(--landing-bg)] text-[var(--landing-ink)]">
      <a href="#main" className="skip-link">
        {t("skipToContent")}
      </a>

      {jsonLd.map((node, index) => (
        <script
          key={`ld-${index}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(node) }}
        />
      ))}

      {showRedirectNotice && (
        <div
          role="status"
          className="border-b border-[var(--landing-line)] bg-[var(--landing-soft)] px-4 py-2 text-center text-[13px] text-[var(--landing-muted)]"
        >
          {t("redirectNotice.text")}
          <a
            href="/auth?mode=login"
            className="ml-2 font-semibold text-[var(--landing-accent)] underline"
          >
            {t("nav.signIn")}
          </a>
        </div>
      )}

      <header className="sticky top-0 z-40 h-[70px] border-b border-[var(--landing-line)] bg-[var(--landing-bg)]">
        <div className="mx-auto flex h-full max-w-[1320px] items-center gap-5 px-5 sm:px-8">
          <a
            href="#main"
            aria-label={SITE_NAME}
            className="flex min-h-11 shrink-0 items-center gap-2.5 no-underline"
          >
            <span className="grid size-7 place-items-center rounded-[7px] bg-[var(--landing-accent)] text-[var(--landing-on-accent)]">
              <Check size={15} strokeWidth={2.3} aria-hidden />
            </span>
            <span className="font-display text-[16px] font-bold tracking-[0.16em] text-[var(--landing-ink)]">
              VANTAGE
            </span>
          </a>

          <nav className="ml-auto hidden items-center gap-7 lg:flex">
            <a className="evidence-link" href="#how">
              {t("nav.howItWorks")}
            </a>
            <a className="evidence-link" href="#chat">
              {t("nav.theAgents")}
            </a>
            <a className="evidence-link" href="#features">
              {t("nav.features")}
            </a>
            <a className="evidence-link" href="#pricing">
              {t("nav.pricing")}
            </a>
            <a className="evidence-link" href="#faq">
              {t("faq.eyebrow")}
            </a>
          </nav>

          <div className="ml-auto flex items-center gap-3 lg:ml-5">
            <LanguageSwitcher />
            {isSignedIn ? (
              <LandingAccountChip />
            ) : (
              <>
                <a
                  href="/auth?mode=login"
                  className="evidence-link !hidden sm:!inline-flex"
                >
                  {t("nav.signIn")}
                </a>
                <a
                  href="/auth"
                  className="evidence-button evidence-button-primary min-h-11 px-4 text-sm"
                >
                  {t("nav.startFree")}
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main">
        <section className="mx-auto grid min-h-[calc(100dvh-70px)] max-w-[1320px] grid-cols-1 items-center gap-12 px-5 py-12 sm:px-8 lg:grid-cols-12 lg:gap-14 lg:py-14">
          <div className="lg:col-span-5">
            <p className="mb-6 text-xs font-bold uppercase tracking-[0.14em] text-[var(--landing-accent)]">
              {t("hero.eyebrow")}
            </p>
            <h1 className="m-0 font-display text-[clamp(3.25rem,6vw,5.9rem)] font-bold leading-[0.91] tracking-[-0.065em] text-[var(--landing-ink)]">
              <span className="block">{t("hero.headlineEvidence.line1")}</span>
              <span className="block">{t("hero.headlineEvidence.line2")}</span>
            </h1>
            <p className="mb-0 mt-7 max-w-[500px] text-[18px] leading-[1.55] text-[var(--landing-muted)]">
              {t("hero.subhead")}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={primaryCtaHref}
                className="evidence-button evidence-button-primary group"
              >
                {primaryCtaLabel}
                <ArrowRight
                  size={17}
                  strokeWidth={1.8}
                  aria-hidden
                  className="transition-transform duration-200 group-hover:translate-x-0.5"
                />
              </a>
              <a
                href="#how"
                className="evidence-button evidence-button-secondary"
              >
                {t("hero.secondaryCta")}
              </a>
            </div>
          </div>

          <div className="min-w-0 lg:col-span-7">
            <HeroConsole />
          </div>
        </section>

        <section
          aria-label={t("evidence.contractLabel")}
          className="border-y border-[var(--landing-line)]"
        >
          <div className="mx-auto grid max-w-[1320px] md:grid-cols-3">
            {contract.map((item, index) => (
              <div
                key={item.title}
                className={`px-5 py-6 sm:px-8 md:py-7 ${
                  index > 0
                    ? "border-t border-[var(--landing-line)] md:border-l md:border-t-0"
                    : ""
                }`}
              >
                <h2 className="m-0 text-[16px] font-semibold text-[var(--landing-ink)]">
                  {item.title}
                </h2>
                <p className="mb-0 mt-1.5 text-[13.5px] leading-[1.5] text-[var(--landing-muted)]">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <ProductJourney copy={journey} />

        <section
          id="chat"
          className="mx-auto max-w-[1320px] px-5 py-24 sm:px-8 md:py-32"
        >
          <div className="max-w-[760px]">
            <h2 className="m-0 text-balance font-display text-[clamp(2.7rem,5vw,4.8rem)] font-bold leading-[0.96] tracking-[-0.055em]">
              {t("evidence.title")}
            </h2>
            <p className="mb-0 mt-5 max-w-[640px] text-[17px] leading-[1.6] text-[var(--landing-muted)]">
              {t("evidence.body")}
            </p>
          </div>

          <figure className="mt-14">
            <div className="relative aspect-[8/5] overflow-hidden rounded-[var(--landing-frame-radius)] border border-[var(--landing-line-strong)] bg-[var(--landing-surface)] shadow-[var(--landing-shadow)]">
              <Image
                src="/demo/workspace.png"
                alt={t("evidence.workspaceAlt")}
                fill
                sizes="(min-width: 1320px) 1256px, 94vw"
                className="object-cover object-left"
              />
            </div>
            <figcaption className="mt-3 text-[12px] text-[var(--landing-subtle)]">
              {t("evidence.workspaceCaption")}
            </figcaption>
          </figure>

          <div
            aria-label={t("evidence.commandsLabel")}
            className="mt-12 grid border-t border-[var(--landing-line)] sm:grid-cols-2"
          >
            {asks.map((ask, index) => (
              <div
                key={ask}
                className={`flex min-h-20 items-center gap-4 border-b border-[var(--landing-line)] py-5 ${
                  index % 2 === 0
                    ? "sm:pr-8"
                    : "sm:border-l sm:pl-8"
                }`}
              >
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-[7px] border border-[var(--landing-line-strong)] text-[var(--landing-accent)]"
                >
                  <ArrowRight size={15} strokeWidth={1.8} />
                </span>
                <span className="text-[15px] font-medium leading-[1.45]">
                  {ask}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section
          id="features"
          className="border-y border-[var(--landing-line)] bg-[var(--landing-surface)]"
        >
          <div className="mx-auto grid max-w-[1320px] gap-14 px-5 py-24 sm:px-8 md:py-32 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
            <div>
              <h2 className="m-0 max-w-[520px] text-balance font-display text-[clamp(2.6rem,4.5vw,4.4rem)] font-bold leading-[0.98] tracking-[-0.052em]">
                {t("features.title")}
              </h2>
              <p className="mb-0 mt-5 max-w-[430px] text-[17px] leading-[1.6] text-[var(--landing-muted)]">
                {t("features.subtitle")}
              </p>
            </div>

            <div className="grid gap-x-12 md:grid-cols-2">
              {featureColumns.map((column, columnIndex) => (
                <div
                  key={`feature-column-${columnIndex}`}
                  className={
                    columnIndex === 1
                      ? "md:border-l md:border-[var(--landing-line)] md:pl-12"
                      : ""
                  }
                >
                  {column.map((feature) => (
                    <article
                      key={feature.title}
                      className="border-t border-[var(--landing-line)] py-7"
                    >
                      <h3 className="m-0 text-[19px] font-semibold tracking-[-0.01em]">
                        {feature.title}
                      </h3>
                      <p className="mb-0 mt-2 max-w-[430px] text-[14.5px] leading-[1.6] text-[var(--landing-muted)]">
                        {feature.body}
                      </p>
                    </article>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1320px] px-5 py-24 sm:px-8 md:py-32">
          <h2 className="m-0 max-w-[820px] text-balance font-display text-[clamp(2.8rem,5vw,4.9rem)] font-bold leading-[0.96] tracking-[-0.055em]">
            {t("bets.title")}
          </h2>

          <div className="mt-14 grid border-t border-[var(--landing-line-strong)] lg:grid-cols-[1.35fr_0.65fr]">
            <article className="py-9 lg:min-h-[360px] lg:pr-16">
              <h3 className="m-0 max-w-[600px] font-display text-[clamp(2rem,3.5vw,3.6rem)] font-semibold leading-[1] tracking-[-0.04em]">
                {principles[0]?.title}
              </h3>
              <p className="mb-0 mt-5 max-w-[560px] text-[17px] leading-[1.65] text-[var(--landing-muted)]">
                {principles[0]?.body}
              </p>
            </article>
            <div className="border-[var(--landing-line-strong)] lg:border-l">
              {principles.slice(1).map((principle) => (
                <article
                  key={principle.title}
                  className="border-b border-[var(--landing-line)] py-8 lg:px-10"
                >
                  <h3 className="m-0 text-[21px] font-semibold">
                    {principle.title}
                  </h3>
                  <p className="mb-0 mt-3 text-[14.5px] leading-[1.6] text-[var(--landing-muted)]">
                    {principle.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <PricingSection />

        <section
          id="faq"
          className="border-y border-[var(--landing-line)] bg-[var(--landing-surface)]"
        >
          <div className="mx-auto max-w-[1320px] px-5 py-24 sm:px-8 md:py-28">
            <h2 className="m-0 max-w-[720px] text-balance font-display text-[clamp(2.5rem,4.5vw,4.2rem)] font-bold leading-[0.98] tracking-[-0.052em]">
              {t("faq.title")}
            </h2>
            <div className="mt-12 grid border-b border-[var(--landing-line)] md:grid-cols-2 md:gap-x-12">
              {faqItems.map((item) => (
                <details
                  key={item.q}
                  className="group border-t border-[var(--landing-line)]"
                >
                  <summary className="flex min-h-[76px] cursor-pointer list-none items-center justify-between gap-5 py-5 text-[16px] font-semibold">
                    <span>{item.q}</span>
                    <span
                      aria-hidden
                      className="text-[24px] font-light text-[var(--landing-accent)] transition-transform duration-200 group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mb-6 mt-0 max-w-[560px] text-[14.5px] leading-[1.65] text-[var(--landing-muted)]">
                    {item.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-[var(--landing-line)]">
          <div className="mx-auto grid max-w-[1320px] items-center gap-8 px-5 py-20 sm:px-8 md:grid-cols-[1fr_auto] md:py-24">
            <div>
              <h2 className="m-0 max-w-[720px] font-display text-[clamp(2.6rem,4.5vw,4.5rem)] font-bold leading-[0.96] tracking-[-0.052em]">
                {t("finalCta.headline")}
              </h2>
              <p className="mb-0 mt-4 max-w-[560px] text-[16px] leading-[1.6] text-[var(--landing-muted)]">
                {t("finalCta.body")}
              </p>
            </div>
            <a
              href={primaryCtaHref}
              className="evidence-button evidence-button-primary group md:min-w-[150px]"
            >
              {primaryCtaLabel}
              <ArrowRight
                size={17}
                strokeWidth={1.8}
                aria-hidden
                className="transition-transform duration-200 group-hover:translate-x-0.5"
              />
            </a>
          </div>
        </section>
      </main>

      <footer>
        <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-5 py-10 sm:px-8 md:flex-row md:items-center">
          <div className="flex items-center gap-2.5">
            <span className="grid size-6 place-items-center rounded-[6px] bg-[var(--landing-accent)] text-[var(--landing-on-accent)]">
              <Check size={13} strokeWidth={2.2} aria-hidden />
            </span>
            <span className="font-display text-[14px] font-bold tracking-[0.15em]">
              VANTAGE
            </span>
          </div>
          <p className="m-0 text-[13px] text-[var(--landing-subtle)]">
            {t("footer.tagline")}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-3 md:ml-auto">
            <a className="evidence-link text-[13px]" href="/legal/privacy">
              {t("footer.privacy")}
            </a>
            <a className="evidence-link text-[13px]" href="/legal/security">
              {t("footer.security")}
            </a>
            <a className="evidence-link text-[13px]" href="/legal/docs">
              {t("footer.docs")}
            </a>
            {SOCIAL_LINKS.map((href) => (
              <a
                key={href}
                href={href}
                rel="me noopener"
                target="_blank"
                className="evidence-link text-[13px]"
              >
                {new URL(href).hostname.replace(/^www\./, "")}
              </a>
            ))}
            <span className="text-[12px] text-[var(--landing-subtle)]">
              © 2026
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
