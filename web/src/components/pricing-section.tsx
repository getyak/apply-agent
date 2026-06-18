"use client";

import { useState } from "react";
import { Check } from "lucide-react";

const FREE_FEATURES = [
  "1 résumé + version history",
  "5 tailored applications / mo",
  "Daily market trends",
  "Client-side autofill",
];

const PRO_FEATURES = [
  "Unlimited tailored applications",
  "40 agent autofills / mo",
  "Unlimited mock interviews",
  "Full trends + skill-gap analysis",
  "Interview vault",
];

const MAX_FEATURES = [
  "Everything in Pro",
  "Unlimited agent autofills",
  "Priority agent runs",
  "Deep interview intelligence",
  "1:1 onboarding session",
];

export default function PricingSection() {
  const [annual, setAnnual] = useState(true);

  const proPrice = annual ? "19" : "24";
  const maxPrice = annual ? "39" : "49";
  const period = annual ? "/mo · billed yearly" : "/ month";

  const pillBase =
    "cursor-pointer border-none font-body font-semibold text-[13px] px-[18px] py-[9px] rounded-full transition-all";

  return (
    <section id="pricing" className="max-w-[1140px] mx-auto px-6 sm:px-8 py-16 md:py-[84px]">
      <div className="text-center mb-3.5">
        <span className="font-display font-bold text-xs tracking-[1.8px] uppercase text-amber">
          Pricing
        </span>
      </div>
      <h2 className="text-center font-display font-bold text-[38px] tracking-[-0.6px] text-ink m-0 mb-[22px]">
        Start free. Upgrade when it&apos;s working.
      </h2>
      <div className="flex justify-center mb-11">
        <div className="flex gap-[3px] bg-[#F3F0EB] border border-border rounded-full p-1">
          <button
            onClick={() => setAnnual(false)}
            className={`${pillBase} ${!annual ? "bg-brown text-[#FAF8F6]" : "bg-transparent text-ink-light"}`}
          >
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            className={`${pillBase} ${annual ? "bg-brown text-[#FAF8F6]" : "bg-transparent text-ink-light"}`}
          >
            Annual · save 20%
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-[22px] items-start">
        <div className="bg-white border border-border rounded-2xl p-[30px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="font-display font-bold text-[13px] tracking-[1px] uppercase text-ink-light mb-2">Free</div>
          <div className="font-body text-[13.5px] text-ink-muted mb-5">Try the full loop</div>
          <div className="flex items-baseline gap-1 mb-6">
            <span className="font-display font-bold text-[42px] text-ink">$0</span>
            <span className="font-body text-sm text-ink-muted">/ forever</span>
          </div>
          <a href="/auth?plan=free" className="block text-center no-underline font-body font-semibold text-sm text-ink bg-white border border-border-dark py-3 rounded-[10px] mb-6 hover:border-brown transition-colors">Get started</a>
          <div className="flex flex-col gap-3">
            {FREE_FEATURES.map((f) => (
              <div key={f} className="flex gap-2.5 font-body text-sm text-[#3a352e]">
                <Check size={16} className="text-ink-muted shrink-0 mt-0.5" strokeWidth={2} />
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-dark border border-dark rounded-2xl p-[30px] shadow-[0_20px_50px_rgba(40,25,5,0.20)] relative">
          <span className="absolute -top-[11px] left-[30px] font-mono text-[10px] tracking-[0.6px] uppercase text-dark bg-gold px-[11px] py-[5px] rounded-[6px]">Most popular</span>
          <div className="font-display font-bold text-[13px] tracking-[1px] uppercase text-dark-gold mb-2">Pro</div>
          <div className="font-body text-[13.5px] text-[#9a9082] mb-5">For an active search</div>
          <div className="flex items-baseline gap-1 mb-6">
            <span className="font-display font-bold text-[42px] text-[#FAF8F6]">${proPrice}</span>
            <span className="font-body text-sm text-[#9a9082]">{period}</span>
          </div>
          <a href="/auth?plan=pro" className="block text-center no-underline font-body font-semibold text-sm text-dark bg-gold py-3 rounded-[10px] mb-6 hover:bg-gold-light transition-colors">Start 7-day trial</a>
          <div className="flex flex-col gap-3">
            {PRO_FEATURES.map((f) => (
              <div key={f} className="flex gap-2.5 font-body text-sm text-[#e6ddd0]">
                <Check size={16} className="text-dark-gold shrink-0 mt-0.5" strokeWidth={2} />
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white border border-border rounded-2xl p-[30px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="font-display font-bold text-[13px] tracking-[1px] uppercase text-ink-light mb-2">Max</div>
          <div className="font-body text-[13.5px] text-ink-muted mb-5">Serious, time-boxed hunt</div>
          <div className="flex items-baseline gap-1 mb-6">
            <span className="font-display font-bold text-[42px] text-ink">${maxPrice}</span>
            <span className="font-body text-sm text-ink-muted">{period}</span>
          </div>
          <a href="/auth?plan=max" className="block text-center no-underline font-body font-semibold text-sm text-[#FAF8F6] bg-brown py-3 rounded-[10px] mb-6 hover:bg-brown-light transition-colors">Go Max</a>
          <div className="flex flex-col gap-3">
            {MAX_FEATURES.map((f) => (
              <div key={f} className="flex gap-2.5 font-body text-sm text-[#3a352e]">
                <Check size={16} className="text-brown shrink-0 mt-0.5" strokeWidth={2} />
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="text-center mt-[26px] font-body text-[13.5px] text-ink-muted">
        Every plan: your data can stay on your device · you always submit applications yourself · cancel anytime
      </div>
    </section>
  );
}
