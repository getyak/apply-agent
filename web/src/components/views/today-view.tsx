"use client";

import { useEffect, useMemo } from "react";
import { useVantage, JOBS, type ApiJob } from "@/lib/store";
import { firstNameOf, fullGreeting, formatToday } from "@/lib/dates";
import {
  Zap,
  ArrowUpRight,
  Clock,
  Sparkles,
} from "lucide-react";

function ApiJobCard({ job, onApply }: { job: ApiJob; onApply: (id: string) => void }) {
  // `matchScore` may be undefined when the matcher hasn't scored this job yet
  // (server down, no résumé selected, etc.). Surface that honestly instead of
  // bucketing every row as "Fair" with a fake 50% bar (QA bug #2).
  const match = job.matchScore;
  const scored = typeof match === "number";
  const fitColor = (m: number) => (m >= 90 ? "#4C7A3F" : m >= 85 ? "#5D3000" : "#A66A00");
  const fitBg = (m: number) => (m >= 90 ? "#EBF3E5" : m >= 85 ? "#F5EDE3" : "#F8ECD6");
  const fitLabel = (m: number) => (m >= 95 ? "Excellent" : m >= 90 ? "Strong" : m >= 85 ? "Good" : "Fair");
  const p = job.parsed;
  const location = p?.locations?.join(", ") || (p?.remote ? "Remote" : "");
  const salary = p?.salary_min && p?.salary_max ? `$${Math.round(p.salary_min / 1000)}–${Math.round(p.salary_max / 1000)}k` : "";

  return (
    <div className="bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px] hover:border-border-dark transition-colors">
      <div className="w-[46px] h-[46px] rounded-[11px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[19px] text-ink shrink-0">
        {job.company.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-[9px] mb-[3px]">
          <span className="font-body font-semibold text-[16px] text-ink">{job.role_title}</span>
          {scored ? (
            <span className="font-mono text-[10px] tracking-[0.4px] uppercase px-2 py-[3px] rounded-[5px]" style={{ color: fitColor(match), background: fitBg(match) }}>
              {fitLabel(match)}
            </span>
          ) : (
            <span className="font-mono text-[10px] tracking-[0.4px] uppercase px-2 py-[3px] rounded-[5px] bg-[#F3F0EB] text-ink-muted">
              Not scored
            </span>
          )}
        </div>
        <div className="font-body text-[13px] text-ink-light">
          {job.company}{location ? ` · ${location}` : ""}{salary ? ` · ${salary}` : ""}
        </div>
        {scored ? (
          <div className="flex items-center gap-[10px] mt-[11px]">
            <div className="w-[120px] h-[6px] rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full bg-green" style={{ width: `${match}%` }} />
            </div>
            <span className="font-mono text-[11px] font-medium text-green">{match}% match</span>
          </div>
        ) : (
          <div className="font-mono text-[11px] text-ink-muted mt-[11px]">
            Add or refresh your résumé so Vantage can score this match.
          </div>
        )}
        {job.matchedSkills && job.matchedSkills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {job.matchedSkills.slice(0, 4).map((s) => (
              <span key={s} className="font-mono text-[9px] tracking-[0.3px] uppercase bg-green-bg text-green px-[6px] py-[2px] rounded">{s}</span>
            ))}
            {job.missingSkills && job.missingSkills.length > 0 && (
              <span className="font-mono text-[9px] tracking-[0.3px] uppercase bg-[#FFF3E0] text-amber px-[6px] py-[2px] rounded">+{job.missingSkills.length} gaps</span>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0">
        <button
          onClick={() => onApply(job.id)}
          className="border-none cursor-pointer bg-brown text-paper font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap hover:bg-brown-light transition-colors"
        >
          <Zap className="w-[15px] h-[15px]" strokeWidth={1.9} />
          Review & apply
        </button>
      </div>
    </div>
  );
}

export function TodayView() {
  const openReview = useVantage((s) => s.openReview);
  const openExtension = useVantage((s) => s.openExtension);
  const apiJobs = useVantage((s) => s.apiJobs);
  const apiJobsLoading = useVantage((s) => s.apiJobsLoading);
  const trendSnapshot = useVantage((s) => s.trendSnapshot);
  const loadJobs = useVantage((s) => s.loadJobs);
  const loadTrends = useVantage((s) => s.loadTrends);
  const currentUser = useVantage((s) => s.currentUser);
  const parsedResume = useVantage((s) => s.parsedResume);
  const loadCurrentUser = useVantage((s) => s.loadCurrentUser);

  useEffect(() => {
    if (apiJobs.length === 0 && !apiJobsLoading) {
      loadJobs();
      loadTrends();
    }
    if (!currentUser) loadCurrentUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fitColor = (m: number) => (m >= 90 ? "#4C7A3F" : m >= 85 ? "#5D3000" : "#A66A00");
  const fitBg = (m: number) => (m >= 90 ? "#EBF3E5" : m >= 85 ? "#F5EDE3" : "#F8ECD6");
  const fitLabel = (m: number) => (m >= 95 ? "Excellent" : m >= 90 ? "Strong" : m >= 85 ? "Good" : "Fair");

  // Prefer the résumé's basics.name (what the user actually wrote) over their
  // auth display_name; both fall through to a friendly nameless greeting.
  const firstName =
    firstNameOf(parsedResume?.basics?.name) || firstNameOf(currentUser?.displayName);
  // useMemo just to keep the rendered "Today" stable inside a single render —
  // we explicitly DON'T want this to be a fresh `new Date()` per re-render
  // (causing hydration mismatches in dev).
  const headerDate = useMemo(() => formatToday(), []);
  const greeting = useMemo(() => fullGreeting(firstName), [firstName]);

  // Real stats only — no fake fallbacks. Empty states are below.
  const totalJobs = trendSnapshot?.totalJobs ?? apiJobs.length;
  // Only count rows the matcher has actually scored. Treating an unscored job
  // as "0" let us claim "0 strong fits" instead of "scoring not ready yet"
  // (QA UX note — surface the empty state honestly).
  const scoredJobs = apiJobs.filter((j) => typeof j.matchScore === "number");
  const strongFits = scoredJobs.filter((j) => (j.matchScore ?? 0) >= 85).length;
  const anyScored = scoredJobs.length > 0;
  const trackedSkills = trendSnapshot?.topSkills?.length ?? 0;

  return (
    <div className="max-w-[880px] mx-auto px-12 pt-10 pb-20 animate-fade-up">
      <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-[10px]">
        {headerDate}
      </div>
      <h1 className="font-display font-bold text-[32px] -tracking-[0.3px] text-ink mb-[22px]">
        {greeting}
      </h1>

      <div className="flex bg-white border border-border rounded-[13px] shadow-sm overflow-hidden mb-[34px]">
        <div className="flex-1 px-[22px] py-[18px]">
          <div className="font-display font-bold text-[26px] text-ink">{totalJobs}</div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            {totalJobs === 1 ? "role in database" : "roles in database"}
          </div>
        </div>
        <div className="w-px bg-border" />
        <div className="flex-1 px-[22px] py-[18px]">
          <div className={`font-display font-bold text-[26px] ${anyScored ? "text-green" : "text-ink-muted"}`}>
            {anyScored ? strongFits : "—"}
          </div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            {!anyScored
              ? "no fits scored yet"
              : strongFits === 0
                ? "no strong fits — try broader filters"
                : strongFits === 1
                  ? "strong fit, ready to send"
                  : "strong fits, ready to send"}
          </div>
        </div>
        <div className="w-px bg-border" />
        <div className="flex-1 px-[22px] py-[18px]">
          <div className="font-display font-bold text-[26px] text-amber">{trackedSkills}</div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            {trackedSkills === 1 ? "trending skill tracked" : "trending skills tracked"}
          </div>
        </div>
      </div>

      {apiJobs.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mb-[14px]">
            <h2 className="font-display font-bold text-[13px] tracking-[1.5px] uppercase text-ink-light m-0">
              Live matches
            </h2>
            {/* Only claim "sorted by fit" when the matcher has actually scored
                something. Otherwise the label fights the uniform "Not scored"
                tags below it (QA bug #2). */}
            <span className="font-body text-[13px] text-ink-muted">
              {anyScored ? "From database · sorted by fit" : "From database · scoring pending"}
            </span>
          </div>
          <div className="flex flex-col gap-[13px] mb-[34px]">
            {apiJobs.map((job) => (
              <ApiJobCard key={job.id} job={job} onApply={(id) => openReview(id)} />
            ))}
          </div>
        </>
      )}

      {apiJobsLoading && apiJobs.length === 0 && (
        <div className="flex flex-col gap-[10px] mb-[34px]">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px] animate-pulse"
            >
              <div className="w-[46px] h-[46px] rounded-[11px] bg-[#F3F0EB]" />
              <div className="flex-1 flex flex-col gap-[7px]">
                <div className="h-[14px] w-[60%] rounded bg-[#F3F0EB]" />
                <div className="h-[10px] w-[40%] rounded bg-[#F3F0EB]" />
                <div className="h-[6px] w-[30%] rounded-full bg-border mt-[4px]" />
              </div>
              <div className="w-[120px] h-[36px] rounded-[9px] bg-[#F3F0EB]" />
            </div>
          ))}
        </div>
      )}

      {/* Demo matches are scaffolding for first-time users: only show them when
          we genuinely have nothing real to show. Once any matched job lands the
          demos disappear so the page stops feeling like a marketing prop. */}
      {!apiJobsLoading && apiJobs.length === 0 && (
        <>
          <div className="flex items-baseline justify-between mb-[14px]">
            <h2 className="font-display font-bold text-[13px] tracking-[1.5px] uppercase text-ink-light m-0">
              While we look for matches
            </h2>
            <span className="font-body text-[13px] text-ink-muted flex items-center gap-1">
              <Sparkles className="w-[13px] h-[13px] text-amber" strokeWidth={1.7} /> Sample of what we&apos;ll surface
            </span>
          </div>

          <div className="flex flex-col gap-[13px]">
        {JOBS.map((job) => (
          <div
            key={job.id}
            className="bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px] hover:border-border-dark transition-colors"
          >
            <div className="w-[46px] h-[46px] rounded-[11px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[19px] text-ink shrink-0">
              {job.mono}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-[9px] mb-[3px]">
                <span className="font-body font-semibold text-[16px] text-ink">
                  {job.role}
                </span>
                <span
                  className="font-mono text-[10px] tracking-[0.4px] uppercase px-2 py-[3px] rounded-[5px]"
                  style={{ color: fitColor(job.match), background: fitBg(job.match) }}
                >
                  {fitLabel(job.match)}
                </span>
              </div>
              <div className="font-body text-[13px] text-ink-light">
                {job.co} · {job.location}
                {job.salary && ` · ${job.salary}`}
              </div>
              <div className="flex items-center gap-[10px] mt-[11px]">
                <div className="w-[120px] h-[6px] rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green"
                    style={{ width: `${job.match}%` }}
                  />
                </div>
                <span className="font-mono text-[11px] font-medium text-green">
                  {job.match}% match
                </span>
              </div>
            </div>
            <div className="shrink-0">
              {job.ready ? (
                <button
                  onClick={() => openReview(job.id)}
                  className="border-none cursor-pointer bg-brown text-paper font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap hover:bg-brown-light transition-colors"
                >
                  <Zap className="w-[15px] h-[15px]" strokeWidth={1.9} />
                  One-click apply
                </button>
              ) : (
                <button
                  onClick={() => openExtension(job.id)}
                  className="cursor-pointer bg-white text-ink border border-border-dark font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap hover:border-brown transition-colors"
                >
                  Apply on site
                  <ArrowUpRight className="w-[14px] h-[14px] text-ink-light" strokeWidth={1.9} />
                </button>
              )}
            </div>
          </div>
        ))}
          </div>

          <div className="mt-5 flex items-center gap-[9px] justify-center font-body text-[13px] text-ink-muted">
            <Clock className="w-[15px] h-[15px]" strokeWidth={1.7} />
            Filled buttons mean everything&apos;s prepared. Outlined ones open the
            company&apos;s own site.
          </div>
        </>
      )}
    </div>
  );
}
