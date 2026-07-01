"use client";

// Post-upload "your résumé just landed" panel — rendered on /app/today between
// the stat strip and the action queue, once a parse finishes successfully.
//
// Why a dedicated card and not "just chips in the dock":
//   1. The dock is a conversation surface; this is a moment-of-completion
//      celebration + map of what to do next. Users need a visible artifact
//      in their main field of view that ties the parse outcome ("we saw
//      these skills, this role") to actionable CTAs.
//   2. Mirrors the §2.1 This-résumé chip vocabulary in
//      docs/architecture/vantage-ui-mapping.md — same prompts as the dock
//      chips, so the two surfaces stay coherent and the user can pick the
//      same action from either place.
//   3. Auto-dismisses once the user kicks off any CTA OR clicks "Got it" —
//      this is a one-time hand-off, not a permanent dashboard widget. The
//      dock greeting carries the same actions for the rest of the session.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Sparkles, ArrowRight, Target, FileSearch, Compass, X } from "lucide-react";
import { useVantage, type ParsedResume } from "@/lib/store";
import { useDock } from "@/lib/ask-vantage-store";
import { sendAsk } from "@/lib/agent-events";
import { resumes as resumesApi } from "@/lib/api";

// Same verbose prompts as the dock's This-résumé chips so the agent gets
// the same fabrication-guard wording from both surfaces. Keep these in sync
// with CHIPS_THIS_RESUME in components/ask-vantage/dock.tsx.
const PROMPT_WEAK =
  "Analyze this résumé and tell me the three weakest spots — be specific about which bullet or section, and what to change. Critique only what is actually written; do not invent skills, employers, dates, or metrics that aren't in the résumé.";
const PROMPT_TAILOR =
  "I want to tailor this résumé for a specific role. Ask me to paste the JD, then customize the bullets to match — without inventing experience I don't have.";
const PROMPT_ROLES =
  "Based on this résumé, suggest five roles that would be a strong match right now — and explain in one line why each fits. Only cite skills, titles, and experiences that appear in the résumé; do not invent qualifications to make a role look like a better fit.";

// Counts years of experience from work entries by summing (endDate||now) -
// startDate per entry, capped at the earliest start to prevent
// double-counting overlapping roles. Returns null when we cannot derive
// anything honest (no work entries / no dates) — the panel hides the
// "years" pill rather than guessing.
function yearsOfExperience(
  work: { startDate?: string; endDate?: string }[] | undefined,
): number | null {
  if (!work || work.length === 0) return null;
  const now = Date.now();
  let earliest: number | null = null;
  for (const w of work) {
    if (!w.startDate) continue;
    const start = Date.parse(w.startDate);
    if (Number.isNaN(start)) continue;
    if (earliest === null || start < earliest) earliest = start;
  }
  if (earliest === null) return null;
  // Use most-recent-end-date as the end anchor; default to "now" if any
  // role is still current (endDate missing or empty).
  let latestEnd = 0;
  let anyOngoing = false;
  for (const w of work) {
    if (!w.endDate) {
      anyOngoing = true;
      continue;
    }
    const end = Date.parse(w.endDate);
    if (!Number.isNaN(end) && end > latestEnd) latestEnd = end;
  }
  const end = anyOngoing || latestEnd === 0 ? now : latestEnd;
  const years = (end - earliest) / (1000 * 60 * 60 * 24 * 365.25);
  return Math.max(0, Math.round(years));
}

export function ResumeLandingCard() {
  const t = useTranslations("today.resumeLanding");
  const parsedResume = useVantage((s) => s.parsedResume);
  const parseJobStatus = useVantage((s) => s.parseJobStatus);
  const resumes = useVantage((s) => s.resumes);
  const currentResumeId = useVantage((s) => s.currentResumeId);
  const router = useRouter();

  // For a returning user (no in-flight parse, but a row already on file)
  // we fetch the snapshot for the active résumé so the card still has
  // signal to display. parsedResume is preferred — it's the freshest
  // post-parse snapshot — but resumesApi.get() works for cold-start.
  const [fetchedResume, setFetchedResume] = useState<ParsedResume | null>(null);
  const activeId = currentResumeId || resumes[0]?.id || null;
  useEffect(() => {
    if (parsedResume || !activeId) return;
    let cancelled = false;
    resumesApi
      .get(activeId)
      .then((res) => {
        if (cancelled) return;
        const content = res.resume?.content as Record<string, unknown> | undefined;
        if (!content) return;
        // resumes.content is the JSON Resume shape itself (no envelope).
        setFetchedResume(content as ParsedResume);
      })
      .catch(() => {
        // Card is celebratory, not load-bearing; failing the fetch just
        // means we don't show it — never a blocker.
      });
    return () => { cancelled = true; };
  }, [parsedResume, activeId]);

  const effectiveResume = parsedResume ?? fetchedResume;

  // Local dismiss — the panel is celebratory, not load-bearing. Once the
  // user fires any CTA we set this so the queue / matches below become the
  // natural focus. Persisted to sessionStorage so re-entering /app/today
  // in the same session doesn't reshow it; a fresh parse clears the flag
  // (we key it by the résumé's name so a NEW parse re-shows).
  const dismissKey = useMemo(() => {
    const name = effectiveResume?.basics?.name ?? activeId ?? "";
    return name ? `vantage.landingCard.dismiss:${name}` : null;
  }, [effectiveResume?.basics?.name, activeId]);

  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined" || !dismissKey) return false;
    return window.sessionStorage.getItem(dismissKey) === "1";
  });

  // Show the card when EITHER:
  //   • a parse just finished and we have a fresh résumé, OR
  //   • the user has at least one row on file (returning user) AND we
  //     loaded its content into fetchedResume.
  const shouldShow =
    !dismissed && ((parseJobStatus === "done" && parsedResume) || effectiveResume !== null);
  if (!shouldShow || !effectiveResume) return null;

  const dismiss = () => {
    setDismissed(true);
    if (typeof window !== "undefined" && dismissKey) {
      window.sessionStorage.setItem(dismissKey, "1");
    }
  };

  const runChip = (prompt: string) => {
    useDock.getState().open();
    void sendAsk(prompt, [], { surface: "dock" });
    dismiss();
  };

  const skills = (effectiveResume.skills ?? [])
    .map((s) => s.name?.trim())
    .filter((n): n is string => Boolean(n))
    .slice(0, 3);
  const latestRole = effectiveResume.work?.[0];
  const years = yearsOfExperience(effectiveResume.work);
  const summary = effectiveResume.basics?.summary?.trim() ?? "";

  return (
    <div
      data-testid="resume-landing-card"
      className="animate-fade-up mb-[34px] rounded-[14px] border border-cream-border bg-white shadow-sm overflow-hidden"
    >
      <div className="flex items-start gap-3 border-b border-cream-border bg-cream px-[20px] py-[14px]">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-white shadow-sm">
          <Sparkles className="h-[16px] w-[16px] text-amber" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] tracking-[1.2px] uppercase text-brown">
            {t("eyebrow")}
          </div>
          <h2 className="mt-[2px] font-display text-[18px] font-bold text-ink">
            {effectiveResume.basics?.name?.trim()
              ? t("titleNamed", { name: effectiveResume.basics.name.trim() })
              : t("titleAnonymous")}
          </h2>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("dismiss")}
          title={t("dismiss")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-white hover:text-ink"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="px-[20px] py-[16px]">
        {summary ? (
          <p className="font-body text-[13.5px] leading-[1.55] text-ink-light mb-[14px]">
            {summary}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2 mb-[18px]">
          {latestRole?.position ? (
            <span className="flex items-center gap-[6px] rounded-full bg-gold-bg px-[10px] py-[5px] font-body text-[12px] text-brown">
              <Target size={12} strokeWidth={2} />
              {latestRole.name
                ? t("latestRoleWithCompany", {
                    position: latestRole.position,
                    company: latestRole.name,
                  })
                : t("latestRoleSolo", { position: latestRole.position })}
            </span>
          ) : null}
          {years !== null ? (
            <span className="rounded-full bg-[#F3F0EB] px-[10px] py-[5px] font-body text-[12px] text-ink">
              {t("yearsExperience", { count: years })}
            </span>
          ) : null}
          {skills.length > 0 ? (
            <span className="rounded-full bg-green-bg px-[10px] py-[5px] font-body text-[12px] text-green">
              {t("topSkills", { list: skills.join(" · ") })}
            </span>
          ) : null}
        </div>

        <div className="font-mono text-[10px] tracking-[1.2px] uppercase text-ink-muted mb-[10px]">
          {t("ctaHeading")}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-[10px]">
          <button
            type="button"
            data-testid="landing-cta-weak"
            onClick={() => runChip(PROMPT_WEAK)}
            className="group flex items-start gap-[10px] rounded-[11px] border border-border bg-white px-[14px] py-[12px] text-left transition-all duration-150 hover:-translate-y-px hover:border-brown hover:shadow-[0_6px_16px_-8px_rgba(61,42,20,0.28)] cursor-pointer"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[#FBEFD8] text-brown">
              <FileSearch size={15} strokeWidth={1.8} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-body text-[13.5px] font-semibold text-ink leading-tight">
                {t("ctaWeakTitle")}
              </span>
              <span className="mt-[3px] flex items-center gap-1 font-mono text-[10px] tracking-[0.6px] uppercase text-ink-muted">
                {t("ctaWeakHint")}
                <ArrowRight size={10} strokeWidth={2} className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </span>
            </span>
          </button>
          <button
            type="button"
            data-testid="landing-cta-tailor"
            onClick={() => runChip(PROMPT_TAILOR)}
            className="group flex items-start gap-[10px] rounded-[11px] border border-border bg-white px-[14px] py-[12px] text-left transition-all duration-150 hover:-translate-y-px hover:border-brown hover:shadow-[0_6px_16px_-8px_rgba(61,42,20,0.28)] cursor-pointer"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[#F4D7D2] text-[#7A2A1F]">
              <Target size={15} strokeWidth={1.8} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-body text-[13.5px] font-semibold text-ink leading-tight">
                {t("ctaTailorTitle")}
              </span>
              <span className="mt-[3px] flex items-center gap-1 font-mono text-[10px] tracking-[0.6px] uppercase text-ink-muted">
                {t("ctaTailorHint")}
                <ArrowRight size={10} strokeWidth={2} className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </span>
            </span>
          </button>
          <button
            type="button"
            data-testid="landing-cta-roles"
            onClick={() => runChip(PROMPT_ROLES)}
            className="group flex items-start gap-[10px] rounded-[11px] border border-border bg-white px-[14px] py-[12px] text-left transition-all duration-150 hover:-translate-y-px hover:border-brown hover:shadow-[0_6px_16px_-8px_rgba(61,42,20,0.28)] cursor-pointer"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[#E2EED9] text-[#2F5722]">
              <Compass size={15} strokeWidth={1.8} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-body text-[13.5px] font-semibold text-ink leading-tight">
                {t("ctaRolesTitle")}
              </span>
              <span className="mt-[3px] flex items-center gap-1 font-mono text-[10px] tracking-[0.6px] uppercase text-ink-muted">
                {t("ctaRolesHint")}
                <ArrowRight size={10} strokeWidth={2} className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </span>
            </span>
          </button>
        </div>

        <div className="mt-[14px] flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.push("/app/studio/resume")}
            className="font-body text-[12.5px] font-medium text-brown hover:text-brown-light transition-colors cursor-pointer"
          >
            {t("openStudioLink")} →
          </button>
          <span className="font-mono text-[10px] tracking-[0.6px] uppercase text-ink-muted">
            {t("hintLine")}
          </span>
        </div>
      </div>
    </div>
  );
}
