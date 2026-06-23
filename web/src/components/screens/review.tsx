"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useVantage, JOBS } from "@/lib/store";
import { Button, Card as UICard, CardHeader as UICardHeader, Badge, ScoreRing } from "@/components/ui";

// contentEditable div whose seed text is captured into state ONCE at first render via the
// useState lazy-initialiser, then the browser owns the text. React never re-controls the div,
// so parent re-renders cannot silently wipe user edits — fixing the previous
// "cover note edits vanish on store update" bug.
function CoverNoteEditable({ initial }: { initial: string }) {
  const t = useTranslations("apply");
  const [seedHtml] = useState(() => escapeHtml(initial));
  return (
    <div
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={t("review.coverNoteAria")}
      className="mt-3.5 font-body text-[13.5px] leading-[1.65] text-ink whitespace-pre-wrap outline-none focus:bg-paper rounded-[8px] -m-1 p-1 transition-colors"
      dangerouslySetInnerHTML={{ __html: seedHtml }}
    />
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function ReviewScreen() {
  const t = useTranslations("apply");
  const activeId = useVantage((s) => s.activeId);
  const backHome = useVantage((s) => s.backHome);
  const submitReview = useVantage((s) => s.submitReview);
  const apiJobs = useVantage((s) => s.apiJobs);

  const job = JOBS.find((j) => j.id === activeId);
  const apiJob = apiJobs.find((j) => j.id === activeId);

  if (!job && !apiJob) return null;

  if (apiJob && !job) {
    const p = apiJob.parsed;
    const match = apiJob.matchScore ?? 50;
    const location = p?.locations?.join(", ") || (p?.remote ? "Remote" : "");
    const salary = p?.salary_min && p?.salary_max ? `$${Math.round(p.salary_min / 1000)}–${Math.round(p.salary_max / 1000)}k` : "";
    const skills = p?.skills || [];
    const matched = apiJob.matchedSkills || [];
    const missing = apiJob.missingSkills || [];

    const TopBar = (
      <div className="h-[60px] shrink-0 border-b border-border bg-paper flex items-center px-5 gap-4">
        <Button onClick={backHome} variant="ghost" size="sm" leadingIcon={<ArrowLeft size={15} />} className="!px-1">
          {t("review.back")}
        </Button>
        <span className="w-px h-5 bg-border-dark" />
        <span className="font-body text-[13.5px] text-ink-light">
          {t("review.reviewApplication")} · <span className="font-semibold text-ink">{apiJob.company}</span>
        </span>
      </div>
    );

    return (
      <div className="h-screen flex flex-col bg-paper">
        {TopBar}
        <div className="flex-1 flex min-h-0">
          <aside className="w-[360px] shrink-0 bg-cream border-r border-border overflow-y-auto p-7">
            <div className="w-[54px] h-[54px] rounded-[13px] bg-paper border border-cream-border flex items-center justify-center mb-4 font-mono font-semibold text-[20px] text-brown">
              {apiJob.company.charAt(0)}
            </div>
            <h1 className="font-display font-bold text-[22px] text-ink leading-tight">{apiJob.role_title}</h1>
            <div className="font-body text-[14px] text-ink-light mt-1">
              {apiJob.company}{location ? ` · ${location}` : ""}{salary ? ` · ${salary}` : ""}
            </div>
            <div className="mt-7 flex items-center gap-4">
              <ScoreRing value={match} size={72} />
              <div>
                <div className="font-display font-bold text-[15px] text-ink">
                  {match >= 85 ? t("review.strongFit") : match >= 70 ? t("review.goodFit") : t("review.fairFit")}
                </div>
                <div className="font-body text-[13px] text-ink-light leading-[1.4]">
                  {t("review.skillsMatched", { count: matched.length })}
                </div>
              </div>
            </div>
            {matched.length > 0 && (
              <div className="mt-8">
                <h2 className="font-mono text-[10.5px] tracking-[0.6px] uppercase text-ink-muted mb-3.5">{t("review.matchedSkills")}</h2>
                <div className="flex flex-wrap gap-2">
                  {matched.map((s) => (
                    <Badge key={s} tone="matched">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
            {missing.length > 0 && (
              <div className="mt-5">
                <h2 className="font-mono text-[10.5px] tracking-[0.6px] uppercase text-ink-muted mb-3.5">{t("review.skillGaps")}</h2>
                <div className="flex flex-wrap gap-2">
                  {missing.map((s) => (
                    <Badge key={s} tone="gap">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
          </aside>

          <section className="flex-1 overflow-y-auto">
            <div className="max-w-[640px] mx-auto px-8 py-8">
              <h2 className="font-display font-bold text-[20px] text-ink">{t("review.yourApplication")}</h2>
              <p className="font-body text-[13.5px] text-ink-light mt-1 mb-6">{t("review.reviewDetails")}</p>

              <UICard padding="md">
                <UICardHeader title={t("review.jobDetails")} tag={t("review.fromDatabase")} />
                <div className="mt-3 font-body text-[13.5px] leading-[1.55] text-ink">
                  <p><strong>{t("review.roleLabel")}:</strong> {apiJob.role_title}</p>
                  <p><strong>{t("review.companyLabel")}:</strong> {apiJob.company}</p>
                  {location && <p><strong>{t("review.locationLabel")}:</strong> {location}</p>}
                  {salary && <p><strong>{t("review.salaryLabel")}:</strong> {salary}</p>}
                  {skills.length > 0 && <p className="mt-2"><strong>{t("review.requiredSkillsLabel")}:</strong> {skills.join(", ")}</p>}
                </div>
              </UICard>
            </div>
          </section>
        </div>

        <div className="shrink-0 border-t border-border bg-white flex items-center gap-4 px-6 py-3.5">
          <div className="flex items-center gap-2 font-body text-[13px] text-ink-light">
            <span className="w-[18px] h-[18px] rounded-full bg-green-bg flex items-center justify-center shrink-0" aria-hidden>
              <Check size={11} className="text-green" strokeWidth={2.6} />
            </span>
            <span>
              <span className="font-semibold text-ink">{t("review.matchPct", { pct: match })}</span> · {t("review.skillsAligned", { count: matched.length })}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <Button onClick={backHome} variant="secondary" size="md">{t("review.saveForLater")}</Button>
            <Button onClick={submitReview} size="md" trailingIcon={<ArrowRight size={15} />}>
              {t("review.submitApplication")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!job) return null;

  const TopBar = (
    <div className="h-[60px] shrink-0 border-b border-border bg-paper flex items-center px-5 gap-4">
      <button
        onClick={backHome}
        className="cursor-pointer inline-flex items-center gap-1.5 font-body font-medium text-[13.5px] text-ink-light hover:text-ink transition-colors bg-transparent border-none"
      >
        <ArrowLeft size={15} />
        {t("review.back")}
      </button>
      <span className="w-px h-5 bg-border-dark" />
      <span className="font-body text-[13.5px] text-ink-light">
        {t("review.reviewApplication")} ·{" "}
        <span className="font-semibold text-ink">{job.co}</span>
      </span>
    </div>
  );

  // External / incomplete job — simpler view
  if (!job.ready || !job.whyBullets) {
    return (
      <div className="h-screen flex flex-col bg-paper">
        {TopBar}
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-[440px] text-center">
            <div className="w-[54px] h-[54px] rounded-[13px] bg-cream border border-cream-border flex items-center justify-center mx-auto mb-5 font-mono font-semibold text-[20px] text-brown">
              {job.mono}
            </div>
            <h1 className="font-display font-bold text-[22px] text-ink leading-tight mb-1">
              {job.role}
            </h1>
            <div className="font-body text-[14px] text-ink-light mb-5">
              {job.co} · {job.location}
            </div>
            {job.whyShort && (
              <p className="font-body text-[14px] leading-[1.6] text-ink-light bg-cream border border-cream-border rounded-[12px] p-4 mb-6 text-left">
                {job.whyShort}
              </p>
            )}
            <p className="font-body text-[13px] text-ink-muted mb-6">
              {t("review.externalRole")}
            </p>
            <Button onClick={backHome} size="md">{t("review.backToToday")}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-paper">
      {TopBar}

      <div className="flex-1 flex min-h-0">
        {/* Left panel */}
        <aside className="w-[360px] shrink-0 bg-cream border-r border-border overflow-y-auto p-7">
          <div className="w-[54px] h-[54px] rounded-[13px] bg-paper border border-cream-border flex items-center justify-center mb-4 font-mono font-semibold text-[20px] text-brown">
            {job.mono}
          </div>
          <h1 className="font-display font-bold text-[22px] text-ink leading-tight">
            {job.role}
          </h1>
          <div className="font-body text-[14px] text-ink-light mt-1">
            {job.co} · {job.location}
          </div>

          {/* Match ring — driven by the same ScoreRing primitive as the apiJob path */}
          <div className="mt-7 flex items-center gap-4">
            <ScoreRing value={job.match} size={72} />
            <div>
              <div className="font-display font-bold text-[15px] text-ink">
                {job.match >= 85 ? t("review.strongFit") : job.match >= 70 ? t("review.goodFit") : t("review.fairFit")}
              </div>
              <div className="font-body text-[13px] text-ink-light leading-[1.4]">
                {t("review.reasonsLineUp", { count: job.whyBullets.length })}
              </div>
            </div>
          </div>

          {/* Why you're a fit */}
          <div className="mt-8">
            <h2 className="font-mono text-[10.5px] tracking-[0.6px] uppercase text-ink-muted mb-3.5">
              {t("review.whyFit")}
            </h2>
            <ul className="flex flex-col gap-3">
              {job.whyBullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="mt-[1px] w-[18px] h-[18px] rounded-full bg-green-bg flex items-center justify-center shrink-0">
                    <Check size={11} className="text-green" strokeWidth={2.6} />
                  </span>
                  <span className="font-body text-[13.5px] leading-[1.5] text-ink">
                    {b}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Right panel */}
        <section className="flex-1 overflow-y-auto">
          <div className="max-w-[640px] mx-auto px-8 py-8">
            <h2 className="font-display font-bold text-[20px] text-ink">
              {t("review.yourApplication")}
            </h2>
            <p className="font-body text-[13.5px] text-ink-light mt-1 mb-6">
              {t("review.amberBlocks")}
            </p>

            {/* Tailored résumé */}
            <UICard>
              <UICardHeader title={t("review.tailoredResume")} tag={t("review.reorderedTag")} ai />
              <ul className="flex flex-col gap-3 mt-3.5">
                {job.resumeBullets?.map((b, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-[7px] w-[5px] h-[5px] rounded-full bg-brown shrink-0" />
                    <span className="font-body text-[13.5px] leading-[1.55] text-ink">
                      {b}
                    </span>
                  </li>
                ))}
              </ul>
            </UICard>

            {/* Cover note — uses the AI tone of Card so the visual signal of AI content stays consistent */}
            <UICard tone="ai" className="mt-5">
              <UICardHeader title={t("review.coverNote")} tag={t("review.draftTag")} ai />
              <CoverNoteEditable initial={job.coverLetter ?? ""} />
              <p className="mt-3 font-body text-[12px] text-ink-muted italic">
                {t("review.coverNoteHint")}
              </p>
            </UICard>

            {/* Screening questions */}
            {job.qa && job.qa.length > 0 && (
              <UICard className="mt-5">
                <UICardHeader title={t("review.screeningQuestions")} tag={t("review.draftedTag")} ai />
                <div className="flex flex-col gap-4 mt-3.5">
                  {job.qa.map((item, i) => (
                    <div key={i}>
                      <div className="font-body font-semibold text-[13.5px] text-ink mb-1.5">
                        {item.q}
                      </div>
                      <div className="font-body text-[13.5px] leading-[1.55] text-ink bg-gold-bg border border-cream-border rounded-[10px] p-3">
                        {item.a}
                      </div>
                    </div>
                  ))}
                </div>
              </UICard>
            )}
          </div>
        </section>
      </div>

      {/* Sticky submit bar */}
      <div className="shrink-0 border-t border-border bg-white flex items-center gap-4 px-6 py-3.5">
        <div className="flex items-center gap-2 font-body text-[13px] text-ink-light">
          <span className="w-[18px] h-[18px] rounded-full bg-green-bg flex items-center justify-center shrink-0" aria-hidden>
            <Check size={11} className="text-green" strokeWidth={2.6} />
          </span>
          <span>
            <span className="font-semibold text-ink">{t("review.blocksReady", { count: (job.resumeBullets?.length ?? 0) + (job.qa?.length ?? 0) + 1 })}</span> · {t("review.writtenByAi")}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <Button onClick={backHome} variant="secondary" size="md">{t("review.saveForLater")}</Button>
          <Button onClick={submitReview} size="md" trailingIcon={<ArrowRight size={15} />}>
            {t("review.looksRightSubmit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
