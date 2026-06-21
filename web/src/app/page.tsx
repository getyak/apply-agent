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
import HeroConsole from "@/components/hero-console";
import PricingSection from "@/components/pricing-section";

const ASKS = [
  '"Find me product design roles under $200k, remote."',
  '"Rewrite my résumé to lead with impact."',
  '"Start the Stripe application and draft the answers."',
  '"Run a mock interview for tomorrow\'s Stripe screen."',
];

const FEATURES = [
  {
    title: "Résumé studio",
    body: "Build and refine by conversation. Every version saved — write once, map everywhere.",
    icon: <FileText size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    title: "Honest AI optimize",
    body: "Sharpens how your real wins read — quantifies, tightens, never invents.",
    icon: <Pencil size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    title: "JD-tailored apply",
    body: "One job description in, one tailored résumé + cover note + answers out.",
    icon: <Search size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    title: "Client-side autofill",
    body: "Fills ATS forms in your browser, on your login. You always submit yourself.",
    icon: <Lock size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    title: "Mock interviews",
    body: "A live AI interviewer that follows up and coaches you after each answer.",
    icon: <MessageSquare size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    title: "Market & flywheel",
    body: "Daily trends plus a personal interview vault that gets richer the more you use it.",
    icon: <BarChart3 size={22} className="text-brown" strokeWidth={1.7} />,
  },
];

const BETS = [
  {
    k: "01",
    title: "Quality over quantity",
    body: "Applying to 11–20 roles converts 3× better than blasting 100+. We help you go narrow and excellent — not spray and pray.",
  },
  {
    k: "02",
    title: "Client-side = zero ban",
    body: "Filling and submitting happen in your browser, your login, your IP. Platforms can't tell human from assisted. Your account stays safe.",
  },
  {
    k: "03",
    title: "Your context is the moat",
    body: "Autofill gets copied. Your résumé history, applications, and interview answers don't — they compound into an assistant that truly knows you.",
  },
];

const STEPS = [
  {
    no: "01",
    title: "Bring yourself in",
    body: "Drop a résumé, paste it, link a profile — or just chat. No forms to fill.",
    icon: <UploadIcon size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    no: "02",
    title: "Get matched",
    body: "Agents scan live roles and rank real fits. Quality, not a thousand long-shots.",
    icon: <Search size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    no: "03",
    title: "Review the package",
    body: "Tailored résumé, cover note, and answers — AI parts marked for a quick glance.",
    icon: <CheckSquare size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    no: "04",
    title: "Submit it yourself",
    body: "The form fills in your own browser. You press submit — zero account risk.",
    icon: <Lock size={22} className="text-brown" strokeWidth={1.7} />,
  },
  {
    no: "05",
    title: "Prep & track",
    body: "Everything lands on a board. Got an interview? A mock is one tap away.",
    icon: <Star size={22} className="text-brown" strokeWidth={1.7} />,
  },
];

export default async function HomePage({
  searchParams,
}: {
  // Next 16 ships dynamic APIs as promises — must await before reading.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  // The middleware bounces unauthenticated visits to /app/* back here with
  // ?source=app_redirect so we can explain the redirect instead of leaving
  // the user wondering why they landed on marketing.
  const showRedirectNotice = params.source === "app_redirect";
  return (
    <div className="min-h-screen">
      {showRedirectNotice && (
        <div
          role="status"
          className="w-full bg-cream border-b border-cream-border text-center font-body text-[13px] text-brown px-4 py-2"
        >
          Please sign in to open your workspace.
          <a
            href="/auth?mode=login"
            className="ml-2 font-semibold underline hover:no-underline"
          >
            Sign in
          </a>
        </div>
      )}
      {/* NAV */}
      <header className="sticky top-0 z-40 backdrop-blur-[20px] bg-paper/82 border-b border-border">
        <div className="max-w-[1140px] mx-auto px-4 sm:px-8 h-[66px] flex items-center gap-3.5">
          <div className="flex items-center gap-[9px]">
            <div className="w-[27px] h-[27px] rounded-[7px] bg-brown flex items-center justify-center">
              <Check size={15} className="text-[#FAF8F6]" strokeWidth={2.2} />
            </div>
            <span className="font-display font-bold text-lg tracking-[3px] text-brown">
              VANTAGE
            </span>
          </div>
          {/* Anchor nav collapses on mobile — the Sign in + Start free CTAs in
              the right-hand cluster are the only nav users need below md. */}
          <nav className="ml-[34px] hidden md:flex items-center gap-7">
            <a href="#how" className="no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors">How it works</a>
            <a href="#chat" className="no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors">The agents</a>
            <a href="#features" className="no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors">Features</a>
            <a href="#pricing" className="no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors">Pricing</a>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <a href="/auth?mode=login" className="no-underline font-body font-medium text-sm text-ink-light hover:text-ink transition-colors">Sign in</a>
            <a href="/auth" className="no-underline font-body font-semibold text-sm text-[#FAF8F6] bg-brown px-[17px] py-[9px] rounded-[9px] hover:bg-brown-light transition-colors">Start free</a>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="max-w-[1140px] mx-auto px-6 sm:px-8 pt-12 sm:pt-[84px] pb-16 grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-14 items-center">
        <div className="animate-fade-up">
          <div className="inline-flex items-center gap-2 bg-cream border border-cream-border rounded-full px-[13px] py-1.5 mb-6">
            <span className="w-[7px] h-[7px] rounded-full bg-green animate-pulse-dot" />
            <span className="font-mono text-[11px] tracking-[0.6px] uppercase text-brown">
              Client-side agents · zero account risk
            </span>
          </div>
          <h1 className="font-display font-bold text-[52px] leading-[1.05] tracking-[-1px] text-ink m-0 mb-5">
            Your job hunt,
            <br />
            run by agents.
            <br />
            <span className="text-brown">Reviewed by you.</span>
          </h1>
          <p className="font-body text-lg leading-[1.55] text-ink-light m-0 mb-8 max-w-[480px]">
            Just tell Vantage what you want. Its agents find the right roles,
            tailor every application, draft your answers, and prep your
            interviews — you review and hit submit.
          </p>
          <div className="flex items-center gap-3.5 mb-[22px]">
            <a href="/auth" className="group sheen-host no-underline inline-flex items-center gap-[9px] font-body font-semibold text-base text-[#FAF8F6] bg-brown px-[26px] py-[15px] rounded-[11px] shadow-[0_2px_8px_-2px_rgba(61,42,20,0.35)] transition-all duration-200 ease-out hover:bg-brown-light hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-8px_rgba(61,42,20,0.5)] active:translate-y-0 active:scale-[0.98]">
              <span className="sheen" aria-hidden />
              Start free
              <ArrowRight size={17} className="transition-transform duration-200 ease-out group-hover:translate-x-1" />
            </a>
            <a href="#how" className="no-underline inline-flex items-center gap-2 font-body font-semibold text-base text-ink bg-white border border-border-dark px-[22px] py-[15px] rounded-[11px] transition-all duration-200 ease-out hover:border-brown hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]">
              See how it works
            </a>
          </div>
          <div className="font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
            No card to start · Your data can stay on your device
          </div>
        </div>
        <div className="animate-fade-up-delay">
          <HeroConsole />
        </div>
      </section>

      {/* ATS strip */}
      <section className="max-w-[1140px] mx-auto px-6 sm:px-8 pt-2 pb-16">
        <div className="flex items-center justify-center gap-[30px] flex-wrap">
          <span className="font-mono text-[11px] tracking-[0.6px] uppercase text-ink-muted">
            Fills forms on
          </span>
          {["Greenhouse", "Lever", "Ashby", "Workday", "Workable"].map((name) => (
            <span key={name} className="font-display font-semibold text-[17px] text-[#8a857d]">{name}</span>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="bg-white border-y border-border">
        <div className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-20">
          <div className="font-display font-bold text-xs tracking-[1.8px] uppercase text-amber mb-3.5">
            The loop
          </div>
          <h2 className="font-display font-bold text-4xl tracking-[-0.6px] text-ink m-0 mb-3 max-w-[620px]">
            From &ldquo;I need a job&rdquo; to submitted — in a handful of clicks.
          </h2>
          <p className="font-body text-[17px] leading-[1.55] text-ink-light m-0 mb-12 max-w-[560px]">
            One calm loop that gets smarter every time you use it. No
            spray-and-pray. No filling the same form twice.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-[18px]">
            {STEPS.map((step) => (
              <div key={step.no} className="group">
                <div className="font-mono text-[11px] tracking-[0.5px] text-border-dark mb-3.5 transition-colors duration-200 group-hover:text-amber">
                  {step.no}
                </div>
                <div className="w-[42px] h-[42px] rounded-[11px] bg-cream border border-cream-border flex items-center justify-center mb-3.5 transition-all duration-300 ease-out group-hover:border-brown group-hover:bg-gold-bg group-hover:-translate-y-0.5 group-hover:shadow-[0_6px_14px_-6px_rgba(61,42,20,0.3)]">
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
      </section>

      {/* CHAT FIRST */}
      <section id="chat" className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-[90px] grid grid-cols-1 md:grid-cols-[1fr_1.05fr] gap-10 md:gap-[60px] items-center">
        <div>
          <div className="font-display font-bold text-xs tracking-[1.8px] uppercase text-amber mb-3.5">
            Chat is the interface
          </div>
          <h2 className="font-display font-bold text-4xl tracking-[-0.6px] text-ink m-0 mb-[18px] leading-[1.1]">
            Stop clicking through tools.
            <br />
            Just ask.
          </h2>
          <p className="font-body text-[17px] leading-[1.6] text-ink-light m-0 mb-7">
            Vantage is one conversation. Behind it, a team of agents quietly
            does the work — updating your résumé, tailoring an application,
            filling a form, launching a mock interview. You stay in one place and
            stay in control.
          </p>
          <div className="flex flex-col gap-3.5">
            {ASKS.map((a) => (
              <div key={a} className="flex items-center gap-[13px]">
                <div className="w-[30px] h-[30px] rounded-lg bg-green-bg flex items-center justify-center shrink-0">
                  <Check size={16} className="text-green" strokeWidth={2} />
                </div>
                <span className="font-body text-[15px] text-ink">{a}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Mini chat mock */}
        <div className="bg-paper border border-border rounded-[18px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
          <div className="h-12 border-b border-border flex items-center gap-2.5 px-[18px] bg-white">
            <div className="w-6 h-6 rounded-[6px] bg-brown flex items-center justify-center">
              <Check size={13} className="text-[#FAF8F6]" strokeWidth={2.2} />
            </div>
            <span className="font-body font-semibold text-sm text-ink">
              Ask Vantage
            </span>
          </div>
          <div className="p-[22px_20px] flex flex-col gap-3.5">
            <div className="self-end bg-brown text-[#FAF8F6] rounded-[13px_13px_4px_13px] py-[11px] px-[15px] font-body text-[13.5px] leading-[1.45] max-w-[80%]">
              Tailor my résumé to the Linear role and start the application.
            </div>
            <div className="flex gap-2.5 items-start">
              <div className="w-7 h-7 rounded-[7px] bg-brown shrink-0 flex items-center justify-center">
                <Star size={13} className="text-[#FAF8F6]" strokeWidth={1.8} />
              </div>
              <div className="max-w-[80%]">
                <div className="bg-white border border-border rounded-[4px_13px_13px_13px] py-3 px-[15px] font-body text-[13.5px] leading-[1.5] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  On it — running two agents now.
                </div>
                <div className="flex flex-col gap-[7px] mt-[9px]">
                  <div className="flex items-center gap-2.5 bg-white border border-cream-border rounded-[9px] py-[9px] px-3">
                    <Zap size={14} className="text-brown" strokeWidth={2} />
                    <span className="flex-1 font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                      Résumé agent
                    </span>
                    <span className="font-mono text-[9px] tracking-[0.5px] uppercase text-green">
                      done
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5 bg-white border border-cream-border rounded-[9px] py-[9px] px-3">
                    <FileText size={14} className="text-brown" strokeWidth={2} />
                    <span className="flex-1 font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                      Application agent
                    </span>
                    <span className="font-mono text-[9px] tracking-[0.5px] uppercase text-green">
                      done
                    </span>
                  </div>
                </div>
                <div className="mt-[9px] bg-[#FFFBF4] border border-cream-border rounded-[11px] py-3 px-3.5 flex items-center gap-2.5">
                  <div className="flex-1 font-body text-[13px] text-[#3a352e]">
                    Your Linear application is ready — <b className="font-semibold">94% match</b>, 2 fields drafted by AI.
                  </div>
                  <span className="font-mono text-[9px] tracking-[0.5px] uppercase text-[#FAF8F6] bg-brown py-[5px] px-[9px] rounded-[6px]">
                    Open
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="px-5 pb-5">
            <div className="flex items-center gap-2.5 bg-white border border-border-dark rounded-xl p-[6px_6px_6px_15px]">
              <span className="flex-1 font-body text-[13.5px] text-ink-muted">
                Ask anything, or launch a task…
              </span>
              <div className="w-8 h-8 rounded-lg bg-brown flex items-center justify-center">
                <Send size={15} className="text-[#FAF8F6]" strokeWidth={2} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="bg-white border-t border-border">
        <div className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-20">
          <div className="font-display font-bold text-xs tracking-[1.8px] uppercase text-amber mb-3.5">
            What it does
          </div>
          <h2 className="font-display font-bold text-4xl tracking-[-0.6px] text-ink m-0 mb-12 max-w-[560px]">
            Six agents. One career context that keeps growing.
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="group lift sheen-host bg-paper border border-border rounded-[14px] p-6 hover:border-border-dark"
              >
                <span className="sheen" aria-hidden />
                <div className="w-11 h-11 rounded-[11px] bg-white border border-border flex items-center justify-center mb-4 transition-all duration-300 ease-out group-hover:border-brown group-hover:bg-cream group-hover:scale-[1.06] group-hover:-rotate-3">
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
      <section className="bg-dark">
        <div className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-[84px]">
          <div className="font-display font-bold text-xs tracking-[1.8px] uppercase text-dark-gold mb-3.5">
            Three bets we made
          </div>
          <h2 className="font-display font-bold text-4xl tracking-[-0.6px] text-[#FAF8F6] m-0 mb-[50px] max-w-[640px]">
            Built the opposite way to every mass-apply bot.
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[26px]">
            {BETS.map((b) => (
              <div key={b.k} className="border-t border-dark-border pt-[22px]">
                <div className="font-display font-bold text-[30px] text-gold mb-3.5">
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
        <div className="bg-cream border border-cream-border rounded-[20px] px-12 py-[60px] text-center">
          <h2 className="font-display font-bold text-[38px] tracking-[-0.6px] text-ink m-0 mb-3.5">
            Hand the busywork to the agents.
          </h2>
          <p className="font-body text-[17px] leading-[1.55] text-ink-light m-0 mx-auto mb-[30px] max-w-[480px]">
            Upload a résumé, or just start talking. You&apos;ll have applications
            ready to review in minutes.
          </p>
          <a href="/auth" className="no-underline inline-flex items-center gap-[9px] font-body font-semibold text-base text-[#FAF8F6] bg-brown px-[30px] py-4 rounded-xl hover:bg-brown-light transition-colors">
            Start free
            <ArrowRight size={17} />
          </a>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-border bg-white">
        <div className="max-w-[1140px] mx-auto px-6 sm:px-8 py-11 flex items-center gap-3.5 flex-wrap">
          <div className="flex items-center gap-[9px]">
            <div className="w-6 h-6 rounded-[6px] bg-brown flex items-center justify-center">
              <Check size={13} className="text-[#FAF8F6]" strokeWidth={2.2} />
            </div>
            <span className="font-display font-bold text-[15px] tracking-[2.5px] text-brown">
              VANTAGE
            </span>
          </div>
          <span className="font-body text-[13px] text-ink-muted ml-2">
            Quality over quantity. Your account, never at risk.
          </span>
          <div className="ml-auto flex gap-6">
            <a href="/legal/privacy" className="no-underline font-body text-[13px] text-ink-light hover:text-ink transition-colors">Privacy</a>
            <a href="/legal/security" className="no-underline font-body text-[13px] text-ink-light hover:text-ink transition-colors">Security</a>
            <a href="/legal/docs" className="no-underline font-body text-[13px] text-ink-light hover:text-ink transition-colors">Docs</a>
            <span className="font-mono text-[11px] tracking-[0.4px] text-ink-muted">
              © 2026
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
