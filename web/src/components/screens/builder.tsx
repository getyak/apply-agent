"use client";

import { useEffect } from "react";
import { useVantage, BUILDER_STAGES } from "@/lib/store";
import { ArrowLeft, Sparkles, Zap, Send } from "lucide-react";
import { Button, Chip } from "@/components/ui";
import { initialsOf } from "@/lib/dates";

// The chat-mode builder is a *scripted demo* of the studio interaction model — the chips and
// agent labels in BUILDER_STAGES are intentionally curated. The live preview pane, however,
// should reflect the user's actual identity (parsedResume → currentUser) instead of the legacy
// "Jordan Avery" placeholder, and the bullets should fall back honestly when we don't have
// real work history yet.
export function BuilderScreen() {
  const builderStep = useVantage((s) => s.builderStep);
  const builderTarget = useVantage((s) => s.builderTarget);
  const builderThinking = useVantage((s) => s.builderThinking);
  const builderChoices = useVantage((s) => s.builderChoices);
  const advanceBuilder = useVantage((s) => s.advanceBuilder);
  const sendBuilder = useVantage((s) => s.sendBuilder);
  const backHome = useVantage((s) => s.backHome);
  const enterApp = useVantage((s) => s.enterApp);
  const parsedResume = useVantage((s) => s.parsedResume);
  const currentUser = useVantage((s) => s.currentUser);

  // BUILD4 (round-13): the round-13 builder audit pointed out that
  // BuilderScreen tracks multi-step progress (builderStep,
  // builderTarget, builderChoices) entirely in Zustand memory — no
  // localStorage backup, no server-side persistence. Round-5 already
  // installed a beforeunload guard on the Settings page (S3); the
  // builder had the same problem and no guard. Reuse the same
  // browser-native confirm dialog approach: when the builder is dirty
  // (the user has advanced past step 0 or picked at least one chip)
  // and a reload/tab-close fires, ask the user to confirm. The
  // listener is no-op when the builder is in its clean initial state,
  // so users who briefly open and close the screen don't get pestered.
  const isBuilderDirty = builderStep > 0 || builderChoices.length > 0;
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isBuilderDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isBuilderDirty]);

  const visibleStages = BUILDER_STAGES.slice(0, builderStep + 1);
  const currentStage = BUILDER_STAGES[builderStep];
  const hasChips = currentStage?.chips && currentStage.chips.length > 0;
  const isDone = builderStep === BUILDER_STAGES.length - 1 && builderChoices.length >= BUILDER_STAGES.length - 1;

  // Real-data identity for the live preview. We never resurrect "Jordan Avery".
  const realName = parsedResume?.basics?.name || currentUser?.displayName || "Your name";
  const realInitials = initialsOf(realName);
  const realEmail = currentUser?.email || "you@example.com";
  const cityRegion = [
    parsedResume?.basics?.location?.city,
    parsedResume?.basics?.location?.region,
  ]
    .filter(Boolean)
    .join(", ");
  const realLocation = cityRegion || "Add a location in settings";
  const realLabel = parsedResume?.basics?.label;
  const realSummary = parsedResume?.basics?.summary;
  const firstWork = parsedResume?.work?.[0];

  const bTitle =
    realLabel ||
    (builderTarget === "Lead / Staff"
      ? "Lead Product Designer"
      : builderTarget === "Senior IC"
        ? "Senior Product Designer"
        : "Product Designer");

  const bTarget = builderTarget === "Lead / Staff"
    ? "Targeting lead and staff design roles — leading with scope, ownership, and team impact."
    : builderTarget === "Senior IC"
      ? "Targeting senior IC roles — leading with craft depth, project ownership, and measurable outcomes."
      : "Open to senior IC and lead roles — positioning for both depth and breadth.";

  // Pull real work bullets if present. Otherwise show a single transparent-honest line —
  // never fabricate three made-up career achievements.
  type WorkLike = { highlights?: string[]; description?: string };
  const w = firstWork as WorkLike | undefined;
  const realBullets: string[] =
    Array.isArray(w?.highlights) && w.highlights.length > 0
      ? w.highlights.filter((h): h is string => typeof h === "string")
      : typeof w?.description === "string" && w.description.trim().length > 0
        ? [w.description]
        : [];
  const showPlaceholderBullets = realBullets.length === 0;

  return (
    <div className="h-full w-full flex overflow-hidden bg-paper animate-fade-in">
      <div className="w-[480px] shrink-0 border-r border-border flex flex-col bg-paper">
        <div className="h-[60px] shrink-0 border-b border-border bg-paper/85 backdrop-blur-xl flex items-center px-[22px] gap-3">
          <button
            onClick={backHome}
            aria-label="Back to home"
            className="cursor-pointer border-none bg-transparent flex items-center text-ink-light p-1 hover:text-ink rounded outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
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
                  <div
                    className="w-[30px] h-[30px] rounded-lg bg-cream-border text-brown shrink-0 flex items-center justify-center font-display font-bold text-[12px]"
                    aria-label={realName}
                  >
                    {realInitials}
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
                <Chip key={c} onClick={() => advanceBuilder(c)}>
                  {c}
                </Chip>
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

      <div className="flex-1 min-w-0 overflow-y-auto h-full py-10">
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
                {realName}
              </h1>
              <div className="font-body text-[15px] text-ink-light">{bTitle}</div>
              <div className="font-mono text-[11px] tracking-[0.4px] text-ink-muted mt-[7px]">
                {realEmail} · {realLocation}
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
                <p className="font-body text-[14px] leading-[1.6] text-ink m-0">
                  {realSummary ||
                    "Tell us about yourself in chat — your summary will land here as we go."}
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
                {firstWork?.name && (
                  <div className="font-body font-semibold text-[14px] text-ink mb-[2px]">
                    {firstWork.position || bTitle}
                    {firstWork.name ? ` · ${firstWork.name}` : ""}
                  </div>
                )}
                <div className="flex flex-col gap-[9px]">
                  {showPlaceholderBullets ? (
                    <div className="flex gap-[10px] items-start">
                      <div className="w-[5px] h-[5px] rounded-full bg-ink-muted mt-2 shrink-0" />
                      <span className="font-body text-[14px] leading-[1.5] text-ink-light italic">
                        Walk me through a project you led — I&apos;ll rewrite it
                        outcome-led, never inventing details.
                      </span>
                    </div>
                  ) : (
                    realBullets.map((b, i) => (
                      <div key={i} className="flex gap-[10px] items-start">
                        <div className="w-[5px] h-[5px] rounded-full bg-brown mt-2 shrink-0" />
                        <span className="font-body text-[14px] leading-[1.5] text-ink">
                          {b}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {isDone && (
            <div className="mt-4 bg-green-bg border border-green-bg rounded-[13px] px-5 py-[18px] flex items-center gap-[14px] animate-pop">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4C7A3F" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="M22 4L12 14.01l-3-3" />
              </svg>
              <div className="flex-1 font-body text-[14px] text-green leading-[1.45]">
                <b className="font-semibold">Profile locked in.</b> Your base
                résumé is ready — every application will be tailored from it.
              </div>
              <Button onClick={enterApp} size="sm">
                See matches
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
