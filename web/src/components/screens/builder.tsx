"use client";

import { useVantage, BUILDER_STAGES } from "@/lib/store";
import { ArrowLeft, Sparkles, Zap, Send } from "lucide-react";

export function BuilderScreen() {
  const builderStep = useVantage((s) => s.builderStep);
  const builderTarget = useVantage((s) => s.builderTarget);
  const builderThinking = useVantage((s) => s.builderThinking);
  const builderChoices = useVantage((s) => s.builderChoices);
  const advanceBuilder = useVantage((s) => s.advanceBuilder);
  const sendBuilder = useVantage((s) => s.sendBuilder);
  const backHome = useVantage((s) => s.backHome);
  const enterApp = useVantage((s) => s.enterApp);

  const visibleStages = BUILDER_STAGES.slice(0, builderStep + 1);
  const currentStage = BUILDER_STAGES[builderStep];
  const hasChips = currentStage?.chips && currentStage.chips.length > 0;
  const isDone = builderStep === BUILDER_STAGES.length - 1 && builderChoices.length >= BUILDER_STAGES.length - 1;

  const bTitle = builderTarget === "Lead / Staff"
    ? "Lead Product Designer"
    : builderTarget === "Senior IC"
      ? "Senior Product Designer"
      : "Product Designer";

  const bTarget = builderTarget === "Lead / Staff"
    ? "Targeting lead and staff design roles — leading with scope, ownership, and team impact."
    : builderTarget === "Senior IC"
      ? "Targeting senior IC roles — leading with craft depth, project ownership, and measurable outcomes."
      : "Open to senior IC and lead roles — positioning for both depth and breadth.";

  const bBullets = builderStep >= 2
    ? [
        "Led the redesign of a real-time collaboration tool used by 40,000 teams — cut design-to-dev handoff time by 60%.",
        "Built and maintained a component-based design system adopted across 3 product lines, reducing UI inconsistencies by 45%.",
        "Mentored 4 mid-level designers to senior, establishing a structured growth framework still in use.",
      ]
    : [
        "Led the redesign of a real-time collaboration tool used by 40,000 teams.",
        "Built a design system adopted across 3 product lines.",
        "Mentored 4 designers from mid to senior level.",
      ];

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-paper animate-fade-in">
      <div className="w-[480px] shrink-0 border-r border-border flex flex-col bg-paper">
        <div className="h-[60px] shrink-0 border-b border-border bg-paper/85 backdrop-blur-xl flex items-center px-[22px] gap-3">
          <button
            onClick={backHome}
            className="cursor-pointer border-none bg-transparent flex items-center text-ink-light p-1 hover:text-ink"
          >
            <ArrowLeft className="w-[19px] h-[19px]" strokeWidth={1.8} />
          </button>
          <div className="w-[26px] h-[26px] rounded-[7px] bg-brown flex items-center justify-center">
            <Sparkles className="w-[14px] h-[14px] text-paper" strokeWidth={1.8} />
          </div>
          <div>
            <div className="font-body font-semibold text-[14px] text-ink leading-[1.1]">
              Résumé studio
            </div>
            <div className="font-mono text-[10px] tracking-[0.5px] uppercase text-ink-muted">
              Building with you
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-[22px] pt-[26px] pb-3 flex flex-col gap-5">
          {visibleStages.map((stage, idx) => (
            <div key={idx}>
              <div className="flex gap-[10px] items-start">
                <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                  <Sparkles className="w-[15px] h-[15px] text-paper" strokeWidth={1.8} />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <div className="font-body text-[14px] leading-[1.55] text-ink max-w-[380px]">
                    {stage.text}
                  </div>
                  {stage.agents && (
                    <div className="flex flex-col gap-[7px] mt-[10px]">
                      {stage.agents.map((a) => (
                        <div
                          key={a.label}
                          className="flex items-center gap-[10px] bg-white border border-cream-border rounded-[9px] px-3 py-[9px]"
                        >
                          <div className="w-[22px] h-[22px] rounded-[6px] bg-cream flex items-center justify-center shrink-0">
                            <Zap className="w-[13px] h-[13px] text-brown" strokeWidth={2} />
                          </div>
                          <span className="flex-1 font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                            {a.label}
                          </span>
                          <span className="font-mono text-[10px] tracking-[0.5px] uppercase text-green">
                            {a.state}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {builderChoices[idx] && (
                <div className="flex gap-[10px] items-start justify-end mt-3">
                  <div className="bg-brown text-paper font-body text-[14px] px-4 py-[9px] rounded-[13px] rounded-br-[4px] max-w-[300px]">
                    {builderChoices[idx]}
                  </div>
                  <div className="w-[30px] h-[30px] rounded-lg bg-cream-border text-brown shrink-0 flex items-center justify-center font-display font-bold text-[12px]">
                    JA
                  </div>
                </div>
              )}
            </div>
          ))}

          {builderThinking && (
            <div className="flex gap-[10px] items-center">
              <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                <Sparkles className="w-[15px] h-[15px] text-paper" strokeWidth={1.8} />
              </div>
              <div className="flex gap-1 px-1">
                <span className="w-[6px] h-[6px] rounded-full bg-border-dark animate-bob" />
                <span className="w-[6px] h-[6px] rounded-full bg-border-dark animate-bob [animation-delay:0.15s]" />
                <span className="w-[6px] h-[6px] rounded-full bg-border-dark animate-bob [animation-delay:0.3s]" />
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 px-[22px] py-3 pb-5 border-t border-border bg-paper">
          {hasChips && !builderThinking && (
            <div className="flex flex-wrap gap-2 mb-3">
              {currentStage.chips.map((c) => (
                <button
                  key={c}
                  onClick={() => advanceBuilder(c)}
                  className="cursor-pointer bg-white border border-border-dark text-ink font-body font-medium text-[13px] px-[14px] py-2 rounded-full hover:border-brown hover:bg-[#FFFDFB] transition-all"
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-[10px] bg-white border border-border-dark rounded-xl pl-4 pr-[5px] py-[5px]">
            <span className="flex-1 font-body text-[14px] text-ink-muted">
              {isDone ? "Your profile is ready" : "Type or pick a suggestion…"}
            </span>
            <button
              onClick={sendBuilder}
              className="cursor-pointer border-none bg-brown w-[34px] h-[34px] rounded-[9px] flex items-center justify-center shrink-0 hover:bg-brown-light transition-colors"
            >
              <Send className="w-4 h-4 text-paper" strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto h-screen py-10">
        <div className="max-w-[620px] mx-auto px-10">
          <div className="flex items-center justify-between mb-4">
            <span className="font-mono text-[10px] tracking-[0.8px] uppercase text-ink-muted">
              Live preview · updates as you talk
            </span>
            <span className="flex items-center gap-[6px] font-mono text-[10px] tracking-[0.5px] uppercase text-green">
              <span className="w-[6px] h-[6px] rounded-full bg-green" />
              {isDone ? "Profile locked" : "Auto-saved"}
            </span>
          </div>

          <div className="bg-white border border-border rounded-[14px] shadow-sm px-[46px] py-[42px] min-h-[600px]">
            <div className="mb-6 pb-5 border-b border-border">
              <h1 className="font-display font-bold text-[30px] -tracking-[0.4px] text-ink mb-1">
                Jordan Avery
              </h1>
              <div className="font-body text-[15px] text-ink-light">{bTitle}</div>
              <div className="font-mono text-[11px] tracking-[0.4px] text-ink-muted mt-[7px]">
                jordan.avery@gmail.com · San Francisco · linkedin.com/in/jordanavery
              </div>
            </div>

            {builderTarget && (
              <div className="mb-5 animate-fade-in">
                <div className="font-display font-bold text-[10px] tracking-[1.4px] uppercase text-amber mb-2">
                  Positioning
                </div>
                <div className="font-body text-[14px] text-ink">{bTarget}</div>
              </div>
            )}

            {builderStep >= 1 && (
              <div className="mb-5 animate-fade-in">
                <div className="font-display font-bold text-[11px] tracking-[1.3px] uppercase text-ink-light mb-[9px]">
                  Summary
                </div>
                <p className="font-body text-[14px] leading-[1.6] text-[#3a352e] m-0">
                  Product designer with 7 years of experience shipping 0→1 products and
                  scaling design systems. Strongest at the intersection of craft and
                  velocity — building tools people genuinely want to use.
                </p>
              </div>
            )}

            {builderStep >= 2 && (
              <div className="animate-fade-in">
                <div className="flex items-center gap-2 mb-[13px]">
                  <span className="font-display font-bold text-[11px] tracking-[1.3px] uppercase text-ink-light">
                    Experience · rewritten
                  </span>
                  <span className="font-mono text-[9px] tracking-[0.5px] uppercase text-amber bg-gold-bg px-[7px] py-[2px] rounded">
                    AI · outcome-led
                  </span>
                </div>
                <div className="font-body font-semibold text-[14px] text-ink mb-[2px]">
                  Lead Product Designer · Mosaic
                </div>
                <div className="font-mono text-[10px] tracking-[0.4px] text-ink-muted mb-[11px]">
                  2021 — Present
                </div>
                <div className="flex flex-col gap-[9px]">
                  {bBullets.map((b, i) => (
                    <div key={i} className="flex gap-[10px] items-start">
                      <div className="w-[5px] h-[5px] rounded-full bg-brown mt-2 shrink-0" />
                      <span className="font-body text-[14px] leading-[1.5] text-ink">
                        {b}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {isDone && (
            <div className="mt-4 bg-green-bg border border-[#cfe3c2] rounded-[13px] px-5 py-[18px] flex items-center gap-[14px] animate-pop">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4C7A3F" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="M22 4L12 14.01l-3-3" />
              </svg>
              <div className="flex-1 font-body text-[14px] text-[#2d4a25] leading-[1.45]">
                <b className="font-semibold">Profile locked in.</b> 38 roles now match — every application is tailored from this.
              </div>
              <button
                onClick={enterApp}
                className="cursor-pointer border-none bg-brown text-paper font-body font-semibold text-[13px] px-[18px] py-[11px] rounded-[9px] whitespace-nowrap hover:bg-brown-light transition-colors"
              >
                See matches
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
