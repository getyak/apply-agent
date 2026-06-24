import {
  Check,
  ArrowRight,
  Upload as UploadIcon,
  Search,
  CheckSquare,
  Lock,
  Star,
  MessageSquare,
  FileText,
  Pencil,
  BarChart3,
  Zap,
  Send,
} from "lucide-react";
import type { CSSProperties } from "react";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import HeroConsole from "@/components/hero-console";
import PricingSection from "@/components/pricing-section";
import LandingMotion from "@/components/landing-motion";
import PointerFX from "@/components/pointer-fx";
import { LandingAccountChip } from "@/components/landing-account-chip";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";

// Shared with web/src/lib/api.ts (TOKEN_COOKIE) and web/src/proxy.ts.
// The cookie is non-httpOnly and mirrored from localStorage on login, which
// lets this server component presence-check auth at render time — the same
// signal the edge proxy uses to gate /app/*. Presence-only: an expired token
// still shows the signed-in nav, then the /app layout's me() guard bounces to
// /auth — behaviour identical to a direct /app visit.
const TOKEN_COOKIE = "vantage_token";

// Icons stay in code (not translatable); copy is keyed into the "landing"
// namespace and zipped in at render time. The order of these icon arrays must
// match the order of the corresponding string arrays in messages/*.json.
const FEATURE_ICONS = [
  <FileText key="f0" size={22} className="text-brown" strokeWidth={1.7} />,
  <Pencil key="f1" size={22} className="text-brown" strokeWidth={1.7} />,
  <Search key="f2" size={22} className="text-brown" strokeWidth={1.7} />,
  <Lock key="f3" size={22} className="text-brown" strokeWidth={1.7} />,
  <MessageSquare key="f4" size={22} className="text-brown" strokeWidth={1.7} />,
  <BarChart3 key="f5" size={22} className="text-brown" strokeWidth={1.7} />,
];

const STEP_ICONS = [
  <UploadIcon key="s0" size={22} className="text-brown" strokeWidth={1.7} />,
  <Search key="s1" size={22} className="text-brown" strokeWidth={1.7} />,
  <CheckSquare key="s2" size={22} className="text-brown" strokeWidth={1.7} />,
  <Lock key="s3" size={22} className="text-brown" strokeWidth={1.7} />,
  <Star key="s4" size={22} className="text-brown" strokeWidth={1.7} />,
];

const STEP_NUMBERS = ["01", "02", "03", "04", "05"];
const BET_KEYS = ["01", "02", "03"];

export default async function HomePage({
  searchParams,
}: {
  // Next 16 ships dynamic APIs as promises — must await before reading.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("landing");
  const params = (await searchParams) ?? {};
  // Zip translatable copy with the in-code icon/number arrays. t.raw() returns
  // the array of strings straight from the active locale's "landing" namespace.
  const asks = t.raw("chat.asks") as string[];
  const features = (t.raw("features.items") as { title: string; body: string }[]).map(
    (f, i) => ({ ...f, icon: FEATURE_ICONS[i] }),
  );
  const bets = (t.raw("bets.items") as { title: string; body: string }[]).map(
    (b, i) => ({ ...b, k: BET_KEYS[i] }),
  );
  const steps = (t.raw("steps.items") as { title: string; body: string }[]).map(
    (s, i) => ({ ...s, no: STEP_NUMBERS[i], icon: STEP_ICONS[i] }),
  );
  // The middleware bounces unauthenticated visits to /app/* back here with
  // ?source=app_redirect so we can explain the redirect instead of leaving
  // the user wondering why they landed on marketing.
  // Signed-in visitors get a "back to your workspace" nav instead of the
  // sign-in / start-free CTAs, so the landing page reflects their session.
  const isSignedIn = Boolean((await cookies()).get(TOKEN_COOKIE)?.value);
  // When signed in, every "Start free" CTA becomes "Open workspace" → /app.
  const primaryCtaHref = isSignedIn ? "/app" : "/auth";
  const primaryCtaLabel = isSignedIn
    ? t("nav.openWorkspace")
    : t("nav.startFree");
  // Only guests can have been bounced here from /app/* by the edge proxy, so
  // the "please sign in" banner is mutually exclusive with the signed-in nav.
  const showRedirectNotice = !isSignedIn && params.source === "app_redirect";
  return (
    <div className="min-h-screen">
      <LandingMotion />
      <PointerFX />
      {showRedirectNotice && (
        <div
          role="status"
          className="w-full bg-cream border-b border-cream-border text-center font-body text-[13px] text-brown px-4 py-2"
        >
          {t("redirectNotice.text")}
          <a
            href="/auth?mode=login"
            className="ml-2 font-semibold underline hover:no-underline"
          >
            {t("nav.signIn")}
          </a>
        </div>
      )}
      {/* NAV */}
      <header className="site-nav sticky top-0 z-40 backdrop-blur-[20px] bg-paper/82 border-b border-border h-[66px]">
        <div className="max-w-[1140px] mx-auto px-4 sm:px-8 h-full flex items-center gap-3.5">
          <div className="nav-assemble flex items-center gap-[9px]" style={{ "--ni": 0 } as CSSProperties}>
            <div className="logo-spark w-[27px] h-[27px] rounded-[7px] bg-brown flex items-center justify-center">
              <Check size={15} className="text-[#FAF8F6]" strokeWidth={2.2} />
            </div>
            <span className="wordmark-gleam weight-hover font-display font-bold text-lg tracking-[3px] text-brown">
              VANTAGE
            </span>
          </div>
          {/* Anchor nav collapses on mobile — the Sign in + Start free CTAs in
              the right-hand cluster are the only nav users need below md. */}
          <nav className="ml-[34px] hidden md:flex items-center gap-7">
            <a href="#how" data-nav-link className="nav-link nav-assemble underline-grow no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors" style={{ "--ni": 1 } as CSSProperties}>{t("nav.howItWorks")}</a>
            <a href="#chat" data-nav-link className="nav-link nav-assemble underline-grow no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors" style={{ "--ni": 2 } as CSSProperties}>{t("nav.theAgents")}</a>
            <a href="#features" data-nav-link className="nav-link nav-assemble underline-grow no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors" style={{ "--ni": 3 } as CSSProperties}>{t("nav.features")}</a>
            <a href="#pricing" data-nav-link className="nav-link nav-assemble underline-grow no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors" style={{ "--ni": 4 } as CSSProperties}>{t("nav.pricing")}</a>
          </nav>
          <div className="nav-assemble ml-auto flex items-center gap-4" style={{ "--ni": 5 } as CSSProperties}>
            <LanguageSwitcher variant="inline" />
            {isSignedIn ? (
              // Avatar chip (name + initials) so the signed-in state is
              // visible at a glance; resolves the name client-side via me().
              <LandingAccountChip />
            ) : (
              <>
                <a href="/auth?mode=login" className="underline-grow no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors">{t("nav.signIn")}</a>
                <a href="/auth" data-magnetic="0.35" data-ripple className="magnet shine cta-aura no-underline font-body font-semibold text-sm text-[#FAF8F6] bg-brown px-[17px] py-[9px] rounded-[9px] hover:bg-brown-light">{t("nav.startFree")}</a>
              </>
            )}
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative overflow-hidden max-w-[1140px] mx-auto px-6 sm:px-8 pt-12 sm:pt-[84px] pb-16 grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-14 items-center">
        {/* Film grain (v10) — a sub-perceptual tactile veil so the warm paper
            field under the hero reads as material, not flat fill. Behind all
            content; pointer-transparent; hidden under reduced-motion. */}
        <div aria-hidden className="grain-overlay" />
        {/* God-ray (v11) — a soft volumetric beam rakes once across the hero on
            first paint, like sun through a window. One-shot, decorative, behind
            all content; hidden under reduced-motion. */}
        <div aria-hidden className="beam -z-10" />
        {/* Ambient cursor light — a warm pool that tracks the reader's pointer
            across the hero, so the surface feels lit by a lamp they're holding.
            Driven by PointerFX; rests dark + invisible with no JS. */}
        <div aria-hidden className="ambient-light -z-10" />
        {/* Warm aurora drift behind the hero — low-opacity light that keeps the
            paper fill from reading dead. Purely decorative. */}
        <div aria-hidden data-parallax="34" className="aurora-blob parallax -z-10 w-[460px] h-[460px] -top-[140px] -left-[120px]" />
        <div aria-hidden data-parallax="-22" className="aurora-blob parallax -z-10 w-[360px] h-[360px] top-[40px] -right-[80px] [animation-delay:-6s] opacity-30" />
        <div className="relative animate-fade-up">
          <div className="badge-glint orbit-ring inline-flex items-center gap-2 bg-cream border border-cream-border rounded-full px-[13px] py-1.5 mb-6">
            <span className="w-[7px] h-[7px] rounded-full bg-green animate-pulse-dot" />
            <span className="font-mono text-[11px] tracking-[0.6px] uppercase text-brown">
              {t("hero.badge")}
            </span>
          </div>
          <h1 className="kinetic-head fluid-display font-display font-bold text-ink m-0 mb-5">
            <span className="kw" style={{ "--kw": 0 } as CSSProperties}>{t("hero.headline.line1")}</span>
            <br />
            <span className="kw" style={{ "--kw": 1 } as CSSProperties}>{t("hero.headline.line2Pre")}</span>{" "}
            <span className="kw gradient-text text-halo crown" style={{ "--kw": 2 } as CSSProperties}>{t("hero.headline.line2Highlight")}</span>
            <span className="kw" style={{ "--kw": 3 } as CSSProperties}>{t("hero.headline.line2Post")}</span>
            <br />
            <span className="text-brown">
              <span className="kw" style={{ "--kw": 4 } as CSSProperties}>{t("hero.headline.line3")}</span>
            </span>
          </h1>
          <p className="text-pretty font-body text-lg leading-[1.55] text-ink-light m-0 mb-8 max-w-[480px]">
            {t("hero.subhead")}
          </p>
          <div className="flex flex-wrap items-center gap-3.5 mb-[22px]">
            <a href={primaryCtaHref} data-magnetic="0.3" data-ripple className="group magnet shine cta-aura cta-breathe sheen-host no-underline inline-flex items-center gap-[9px] font-body font-semibold text-base text-[#FAF8F6] bg-brown px-[26px] py-[15px] rounded-[11px] shadow-[0_2px_8px_-2px_rgba(61,42,20,0.35)] hover:bg-brown-light hover:shadow-[0_14px_30px_-8px_rgba(61,42,20,0.55)]">
              <span className="sheen" aria-hidden />
              {primaryCtaLabel}
              <ArrowRight size={17} className="transition-transform duration-200 ease-out group-hover:translate-x-1" />
            </a>
            <a href="#how" className="lift-pop pressure shine no-underline inline-flex items-center gap-2 font-body font-semibold text-base text-ink bg-white border border-border-dark px-[22px] py-[15px] rounded-[11px] hover:border-brown">
              {t("hero.secondaryCta")}
            </a>
          </div>
          <div className="font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
            {t("hero.microcopy")}
          </div>
        </div>
        <div className="animate-fade-up-delay">
          <div className="animate-buoy">
            <div data-tilt="6" className="tilt-pointer">
              <HeroConsole />
            </div>
          </div>
        </div>
      </section>

      {/* ATS strip */}
      <section className="max-w-[1140px] mx-auto px-6 sm:px-8 pt-2 pb-16">
        <div data-reveal className="scan-strip flex items-center justify-center gap-[30px] flex-wrap py-2">
          <span className="font-mono text-[11px] tracking-[0.6px] uppercase text-ink-muted">
            {t("atsStrip.label")}
          </span>
          {["Greenhouse", "Lever", "Ashby", "Workday", "Workable"].map((name, i) => (
            <span
              key={name}
              data-reveal
              style={{ "--reveal-delay": `${i * 60}ms` } as CSSProperties}
              className="press font-display font-semibold text-[17px] text-[#8a857d] transition-[color,transform] duration-200 ease-out hover:text-brown hover:-translate-y-0.5"
            >
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="bg-white border-y border-border">
        <div className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-20">
          <div data-reveal className="font-display font-bold text-xs tracking-[1.8px] uppercase text-amber mb-3.5">
            <span className="eyebrow-dot" aria-hidden />{t("steps.eyebrow")}<span className="eyebrow-rule" aria-hidden />
          </div>
          <h2 data-reveal style={{ "--reveal-delay": "60ms" } as CSSProperties} className="head-rule balance font-display font-bold text-4xl tracking-[-0.6px] text-ink m-0 mb-3 max-w-[620px]">
            {t("steps.title")}
          </h2>
          <p data-reveal style={{ "--reveal-delay": "120ms" } as CSSProperties} className="text-pretty font-body text-[17px] leading-[1.55] text-ink-light m-0 mb-12 max-w-[560px]">
            {t("steps.subtitle")}
          </p>
          <div className="relative">
            {/* Connective thread (v18) — a warm rail draws across the row when
                the section is first seen, threading behind the opaque icon
                tiles so the five steps read as one pipeline. lg-only (the steps
                stack below it); shares the reveal observer + its fallbacks. */}
            <div aria-hidden data-reveal className="flow-rail hidden lg:block" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-[18px]">
            {steps.map((step, i) => (
              <div key={step.no} data-reveal style={{ "--reveal-delay": `${i * 80}ms` } as CSSProperties} className="group relative">
                <div className="ghost-num select-none text-[34px] tracking-[-1px] mb-2 leading-none">
                  {step.no}
                </div>
                <div className="icon-glow w-[42px] h-[42px] rounded-[11px] bg-cream border border-cream-border flex items-center justify-center mb-3.5 transition-all duration-300 ease-out group-hover:border-brown group-hover:bg-gold-bg group-hover:-translate-y-0.5 group-hover:shadow-[0_6px_14px_-6px_rgba(61,42,20,0.3)]">
                  {step.icon}
                </div>
                <div className="font-body font-semibold text-[15px] text-ink mb-1.5">
                  {step.title}
                </div>
                <div className="font-body text-[13.5px] leading-[1.5] text-ink-light">
                  {step.body}
                </div>
              </div>
            ))}
            </div>
          </div>
        </div>
      </section>

      {/* CHAT FIRST */}
      <section id="chat" className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-[90px] grid grid-cols-1 md:grid-cols-[1fr_1.05fr] gap-10 md:gap-[60px] items-center">
        <div data-reveal className="reveal-l">
          <div className="font-display font-bold text-xs tracking-[1.8px] uppercase text-amber mb-3.5">
            <span className="eyebrow-dot" aria-hidden />{t("chat.eyebrow")}<span className="eyebrow-rule" aria-hidden />
          </div>
          <h2 className="font-display font-bold text-4xl tracking-[-0.6px] text-ink m-0 mb-[18px] leading-[1.1]">
            {t("chat.titleLine1")}
            <br />
            {t("chat.titleLine2")}
          </h2>
          <p className="text-pretty font-body text-[17px] leading-[1.6] text-ink-light m-0 mb-7">
            {t("chat.body")}
          </p>
          <div className="flex flex-col gap-3.5">
            {asks.map((a, i) => (
              <div
                key={a}
                data-reveal
                style={{ "--reveal-delay": `${i * 80}ms` } as CSSProperties}
                className="proof-row flex items-center gap-[13px]"
              >
                <div className="proof-check w-[30px] h-[30px] rounded-lg bg-green-bg flex items-center justify-center shrink-0">
                  <Check size={16} className="text-green" strokeWidth={2} />
                </div>
                <span className="font-body text-[15px] text-ink">{a}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Mini chat mock */}
        <div data-reveal className="reveal-r" style={{ "--reveal-delay": "120ms" } as CSSProperties}>
          <div data-tilt="5" className="group grad-border tilt-pointer tilt-shine bg-paper border border-border rounded-[18px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden" data-active="true">
          <div className="h-12 border-b border-border flex items-center gap-2.5 px-[18px] bg-white">
            <div className="w-6 h-6 rounded-[6px] bg-brown flex items-center justify-center">
              <Check size={13} className="text-[#FAF8F6]" strokeWidth={2.2} />
            </div>
            <span className="font-body font-semibold text-sm text-ink">
              {t("chatMock.title")}
            </span>
          </div>
          <div className="p-[22px_20px] flex flex-col gap-3.5">
            <div style={{ "--md": "260ms" } as CSSProperties} className="mock-step self-end bg-brown text-[#FAF8F6] rounded-[13px_13px_4px_13px] py-[11px] px-[15px] font-body text-[13.5px] leading-[1.45] max-w-[80%]">
              {t("chatMock.userMessage")}
            </div>
            <div className="flex gap-2.5 items-start">
              <div className="w-7 h-7 rounded-[7px] bg-brown shrink-0 flex items-center justify-center">
                <Star size={13} className="text-[#FAF8F6]" strokeWidth={1.8} />
              </div>
              <div className="max-w-[80%]">
                <div style={{ "--md": "420ms" } as CSSProperties} className="mock-step bg-white border border-border rounded-[4px_13px_13px_13px] py-3 px-[15px] font-body text-[13.5px] leading-[1.5] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  {t("chatMock.reply")}
                </div>
                <div className="flex flex-col gap-[7px] mt-[9px]">
                  <div style={{ "--md": "560ms" } as CSSProperties} className="mock-step mock-row flex items-center gap-2.5 bg-white border border-cream-border rounded-[9px] py-[9px] px-3">
                    <Zap size={14} className="text-brown" strokeWidth={2} />
                    <span className="flex-1 font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                      {t("chatMock.resumeAgent")}
                    </span>
                    <span style={{ "--md": "900ms" } as CSSProperties} className="mock-done font-mono text-[9px] tracking-[0.5px] uppercase text-green">
                      {t("chatMock.done")}
                    </span>
                  </div>
                  <div style={{ "--md": "680ms" } as CSSProperties} className="mock-step mock-row flex items-center gap-2.5 bg-white border border-cream-border rounded-[9px] py-[9px] px-3">
                    <FileText size={14} className="text-brown" strokeWidth={2} />
                    <span className="flex-1 font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                      {t("chatMock.applicationAgent")}
                    </span>
                    <span style={{ "--md": "1020ms" } as CSSProperties} className="mock-done font-mono text-[9px] tracking-[0.5px] uppercase text-green">
                      {t("chatMock.done")}
                    </span>
                  </div>
                </div>
                <div style={{ "--md": "1160ms" } as CSSProperties} className="mock-step mt-[9px] bg-[#FFFBF4] border border-cream-border rounded-[11px] py-3 px-3.5 flex items-center gap-2.5">
                  <div className="flex-1 font-body text-[13px] text-[#3a352e]">
                    {t.rich("chatMock.result", {
                      b: (chunks) => (
                        <b className="font-semibold">{chunks}</b>
                      ),
                    })}
                  </div>
                  <span className="font-mono text-[9px] tracking-[0.5px] uppercase text-[#FAF8F6] bg-brown py-[5px] px-[9px] rounded-[6px]">
                    {t("chatMock.open")}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="px-5 pb-5">
            <div className="flex items-center gap-2.5 bg-white border border-border-dark rounded-xl p-[6px_6px_6px_15px]">
              <span className="flex-1 font-body text-[13.5px] text-ink-muted">
                {t("chatMock.composerPlaceholder")}
              </span>
              <div className="w-8 h-8 rounded-lg bg-brown flex items-center justify-center">
                <Send size={15} className="text-[#FAF8F6]" strokeWidth={2} />
              </div>
            </div>
          </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="bg-white border-t border-border">
        <div className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-20">
          <div data-reveal className="font-display font-bold text-xs tracking-[1.8px] uppercase text-amber mb-3.5">
            <span className="eyebrow-dot" aria-hidden />{t("features.eyebrow")}<span className="eyebrow-rule" aria-hidden />
          </div>
          <h2 data-reveal style={{ "--reveal-delay": "60ms" } as CSSProperties} className="head-rule balance font-display font-bold text-4xl tracking-[-0.6px] text-ink m-0 mb-12 max-w-[560px]">
            {t("features.title")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f, i) => (
              <div
                key={f.title}
                data-reveal
                data-tilt="3.5"
                style={{ "--reveal-delay": `${(i % 3) * 80}ms` } as CSSProperties}
                className="group tilt-pointer tilt-shine rim spotlight sheen-host bg-paper border border-border rounded-[14px] p-6 hover:border-border-dark"
              >
                <span className="sheen" aria-hidden />
                <div className="icon-glow w-11 h-11 rounded-[11px] bg-white border border-border flex items-center justify-center mb-4 transition-all duration-300 ease-out group-hover:border-brown group-hover:bg-cream group-hover:scale-[1.06] group-hover:-rotate-3">
                  {f.icon}
                </div>
                <div className="font-body font-semibold text-base text-ink mb-[7px]">
                  {f.title}
                </div>
                <div className="font-body text-sm leading-[1.55] text-ink-light">
                  {f.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* DIFFERENTIATORS */}
      <section className="relative overflow-hidden bg-dark">
        {/* Ember-toned drifting mesh — gives the near-black panel atmospheric
            depth so it reads as lit, not a dead fill. Purely decorative. */}
        {/* Engineered dot-field (v11) — a faint warm grid that gives the dark
            panel blueprint-like depth beneath the softer mesh + embers. */}
        <div aria-hidden className="dot-field -z-0" />
        <div aria-hidden className="aurora-mesh on-dark -z-0 opacity-70" />
        {/* Pointer-tracked ember — the dark panel lights up where the reader
            looks, layered over the drifting mesh. */}
        <div aria-hidden className="ambient-light on-dark -z-0" />
        {/* Rising embers — a slow column of warm motes drifting up the panel so
            it reads as a banked fire, not a flat fill. Purely decorative. */}
        <div aria-hidden className="embers -z-0">
          {[
            { left: "8%", dur: "9.5s", delay: "0s", drift: "14px" },
            { left: "18%", dur: "11s", delay: "1.6s", drift: "-10px" },
            { left: "29%", dur: "8.5s", delay: "3.1s", drift: "8px" },
            { left: "41%", dur: "12s", delay: "0.8s", drift: "-16px" },
            { left: "52%", dur: "10s", delay: "2.4s", drift: "12px" },
            { left: "63%", dur: "9s", delay: "4s", drift: "-9px" },
            { left: "73%", dur: "11.5s", delay: "1.2s", drift: "16px" },
            { left: "84%", dur: "8.8s", delay: "3.6s", drift: "-12px" },
            { left: "93%", dur: "10.5s", delay: "2s", drift: "10px" },
          ].map((e, i) => (
            <span
              key={i}
              className="ember"
              style={
                {
                  left: e.left,
                  "--dur": e.dur,
                  "--delay": e.delay,
                  "--drift": e.drift,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <div className="relative z-10 max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-[84px]">
          <div data-reveal className="font-display font-bold text-xs tracking-[1.8px] uppercase text-dark-gold mb-3.5">
            <span className="eyebrow-dot" aria-hidden />{t("bets.eyebrow")}
          </div>
          <h2 data-reveal style={{ "--reveal-delay": "60ms" } as CSSProperties} className="head-rule balance font-display font-bold text-4xl tracking-[-0.6px] text-[#FAF8F6] m-0 mb-[50px] max-w-[640px]">
            {t("bets.title")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[26px]">
            {bets.map((b, i) => (
              <div key={b.k} data-reveal data-glow style={{ "--reveal-delay": `${i * 90}ms` } as CSSProperties} className="group card-glow on-dark ignite-rule border-t border-dark-border pt-[22px] transition-colors duration-300 hover:border-gold/50">
                <div className="font-display font-bold text-[30px] gradient-text mb-3.5 transition-transform duration-300 ease-out group-hover:-translate-y-0.5">
                  {b.k}
                </div>
                <div className="font-body font-semibold text-lg text-[#FAF8F6] mb-2.5">
                  {b.title}
                </div>
                <div className="font-body text-[14.5px] leading-[1.6] text-dark-text">
                  {b.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <PricingSection />

      {/* CTA */}
      <section className="max-w-[1140px] mx-auto px-8 pt-5 pb-[90px]">
        <div data-reveal className="reveal-scale group grad-border edge-light relative overflow-hidden bg-cream border border-cream-border rounded-[20px] px-12 py-[60px] text-center" data-active="true">
          {/* Conic halo (v11) — a slow-rotating ring of warm light behind the
              panel so the closing CTA reads as genuinely radiant. Self-contained
              decorative layer; hidden under reduced-motion. */}
          <div aria-hidden className="cta-conic -z-0" />
          {/* Warm light pooling under the headline. */}
          <div aria-hidden data-parallax="28" className="aurora-blob parallax -z-0 w-[420px] h-[420px] -top-[180px] left-1/2 -translate-x-1/2 opacity-40" />
          <div className="relative z-10">
            <h2 className="kinetic-head font-display font-bold text-[28px] sm:text-[38px] tracking-[-0.6px] text-ink m-0 mb-3.5">
              <span className="kw" style={{ "--kw": 0 } as CSSProperties}>{t("finalCta.headlinePre")}</span>{" "}
              <span className="kw gradient-text text-halo crown" style={{ "--kw": 1 } as CSSProperties}>{t("finalCta.headlineHighlight")}</span>
              <span className="kw" style={{ "--kw": 2 } as CSSProperties}>{t("finalCta.headlinePost")}</span>
            </h2>
            <p className="text-pretty font-body text-[17px] leading-[1.55] text-ink-light m-0 mx-auto mb-[30px] max-w-[480px]">
              {t("finalCta.body")}
            </p>
            <a href={primaryCtaHref} data-magnetic="0.3" data-ripple className="group/cta magnet shine cta-aura no-underline inline-flex items-center gap-[9px] font-body font-semibold text-base text-[#FAF8F6] bg-brown px-[30px] py-4 rounded-xl hover:bg-brown-light">
              {primaryCtaLabel}
              <ArrowRight size={17} className="transition-transform duration-200 ease-out group-hover/cta:translate-x-1" />
            </a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="edge-light relative border-t border-border bg-white">
        <div data-reveal className="max-w-[1140px] mx-auto px-6 sm:px-8 py-11 flex items-center gap-3.5 flex-wrap">
          <div className="flex items-center gap-[9px]">
            <div className="logo-spark w-6 h-6 rounded-[6px] bg-brown flex items-center justify-center">
              <Check size={13} className="text-[#FAF8F6]" strokeWidth={2.2} />
            </div>
            <span className="wordmark-gleam weight-hover font-display font-bold text-[15px] tracking-[2.5px] text-brown">
              VANTAGE
            </span>
          </div>
          <span className="font-body text-[13px] text-ink-muted ml-2">
            {t("footer.tagline")}
          </span>
          <div className="ml-auto flex gap-6">
            <a href="/legal/privacy" className="underline-grow no-underline font-body text-[13px] text-ink-light hover:text-ink transition-colors">{t("footer.privacy")}</a>
            <a href="/legal/security" className="underline-grow no-underline font-body text-[13px] text-ink-light hover:text-ink transition-colors">{t("footer.security")}</a>
            <a href="/legal/docs" className="underline-grow no-underline font-body text-[13px] text-ink-light hover:text-ink transition-colors">{t("footer.docs")}</a>
            <span className="font-mono text-[11px] tracking-[0.4px] text-ink-muted">
              © 2026
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
