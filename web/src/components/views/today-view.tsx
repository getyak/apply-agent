"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useVantage, JOBS, type ApiJob } from "@/lib/store";
import { firstNameOf, fullGreeting, formatToday } from "@/lib/dates";
import {
  Zap,
  ArrowUpRight,
  Clock,
  Sparkles,
} from "lucide-react";
import { today as todayApi, type TodayAction } from "@/lib/api";
import { sendAsk } from "@/lib/agent-events";
import { useDock } from "@/lib/ask-vantage-store";

type Translator = ReturnType<typeof useTranslations>;

// H2 (round-1): turn the server's `priority` score (0–100) into a
// human-readable "why is this the top of my queue" hint. The route
// already ranks rows by score (api/src/routes/today.ts:43,84,129) but
// until now the score never reached the UI — users were left guessing
// why one row beat another. Each rule maps the existing kind + priority
// inputs into a short mono label rendered to the right of the row, so
// scanning the queue tells you both *what* and *why*.
function whyThisCard(a: TodayAction, t: Translator): string {
  if (a.kind === "interview") {
    // priority is max(80, 100 - days*3) on the route side, so anything
    // ≥97 is tomorrow-or-today and deserves the louder label.
    return a.priority >= 97 ? t("why.interviewImminent") : t("why.interviewThisWeek");
  }
  if (a.kind === "prepare") {
    // priority is 70 + min(20, age_days*2), so ≥85 means the draft has
    // been sitting ≥7 days (15 + age component). Call that out so the
    // user sees the queue is nudging them to unblock it.
    return a.priority >= 85 ? t("why.draftAging") : t("why.openDraft");
  }
  if (a.kind === "follow_up") return t("why.awaitingReply");
  return t("why.skillGap");
}

// Small status chip for action queue rows. Distinct color tracks let
// the user scan "prep / interview / learn" at a glance without reading
// titles — matches the dock's TaskGraphStepPill aesthetic.
function ActionKindPill({ kind, t }: { kind: TodayAction["kind"]; t: Translator }) {
  const spec = (() => {
    if (kind === "interview") return { text: t("pill.interview"), fg: "#7A2A1F", bg: "#F4D7D2" };
    if (kind === "prepare") return { text: t("pill.prep"), fg: "#5D3000", bg: "#FBEFD8" };
    if (kind === "follow_up") return { text: t("pill.followUp"), fg: "#8A6A12", bg: "#FBEFD0" };
    return { text: t("pill.learn"), fg: "#2F5722", bg: "#E2EED9" };
  })();
  return (
    <span
      className="flex-shrink-0"
      style={{
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 9.5,
        letterSpacing: 0.6,
        padding: "3px 8px",
        borderRadius: 999,
        color: spec.fg,
        background: spec.bg,
      }}
    >
      {spec.text}
    </span>
  );
}

function ApiJobCard({ job, onApply, t }: { job: ApiJob; onApply: (id: string) => void; t: Translator }) {
  // `matchScore` may be undefined when the matcher hasn't scored this job yet
  // (server down, no résumé selected, etc.). Surface that honestly instead of
  // bucketing every row as "Fair" with a fake 50% bar (QA bug #2).
  const match = job.matchScore;
  const scored = typeof match === "number";
  const fitColor = (m: number) => (m >= 90 ? "#4C7A3F" : m >= 85 ? "#5D3000" : "#A66A00");
  const fitBg = (m: number) => (m >= 90 ? "#EBF3E5" : m >= 85 ? "#F5EDE3" : "#F8ECD6");
  const fitLabel = (m: number) =>
    m >= 95 ? t("fit.excellent") : m >= 90 ? t("fit.strong") : m >= 85 ? t("fit.good") : t("fit.fair");
  const p = job.parsed;
  const location = p?.locations?.join(", ") || (p?.remote ? t("remote") : "");
  const salary = p?.salary_min && p?.salary_max ? `$${Math.round(p.salary_min / 1000)}–${Math.round(p.salary_max / 1000)}k` : "";

  return (
    <div className="group lift bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px] hover:border-border-dark">
      <div className="w-[46px] h-[46px] rounded-[11px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[19px] text-ink shrink-0 transition-all duration-300 ease-out group-hover:bg-gold-bg group-hover:scale-[1.05]">
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
              {t("notScored")}
            </span>
          )}
        </div>
        <div className="font-body text-[13px] text-ink-light">
          {job.company}{location ? ` · ${location}` : ""}{salary ? ` · ${salary}` : ""}
        </div>
        {scored ? (
          <div className="flex items-center gap-[10px] mt-[11px]">
            <div className="bar-track w-[120px] h-[6px] rounded-full bg-border overflow-hidden">
              <div className="bar-fill h-full rounded-full bg-[linear-gradient(90deg,#4C7A3F,#5E9B4D)]" style={{ width: `${match}%` }} />
            </div>
            <span className="font-mono text-[11px] font-medium text-green">{t("percentMatch", { pct: match })}</span>
          </div>
        ) : (
          <div className="font-mono text-[11px] text-ink-muted mt-[11px]">
            {t("addResumeToScore")}
          </div>
        )}
        {job.matchedSkills && job.matchedSkills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {job.matchedSkills.slice(0, 4).map((s) => (
              <span key={s} className="font-mono text-[9px] tracking-[0.3px] uppercase bg-green-bg text-green px-[6px] py-[2px] rounded">{s}</span>
            ))}
            {job.missingSkills && job.missingSkills.length > 0 && (
              <span className="font-mono text-[9px] tracking-[0.3px] uppercase bg-[#FFF3E0] text-amber px-[6px] py-[2px] rounded">{t("skillGaps", { count: job.missingSkills.length })}</span>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0">
        <button
          onClick={() => onApply(job.id)}
          className="border-none cursor-pointer bg-brown text-paper font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap shadow-[0_1px_2px_rgba(61,42,20,0.18)] transition-all duration-200 ease-out hover:bg-brown-light hover:shadow-[0_6px_16px_-6px_rgba(61,42,20,0.5)] active:scale-[0.97]"
        >
          <Zap className="w-[15px] h-[15px] transition-transform duration-300 ease-out group-hover:rotate-[-8deg] group-hover:scale-110" strokeWidth={1.9} />
          {t("reviewAndApply")}
        </button>
      </div>
    </div>
  );
}

export function TodayView() {
  const t = useTranslations("today");
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

  // Action queue (P3.1). Fire-and-forget on mount; the page renders
  // happily without it (this is *additive* — the existing live-matches
  // section is the historical default). Setting `loaded` lets the empty
  // and the loading shell render differently so we don't claim "no
  // actions" while we're still fetching.
  const [actionQueue, setActionQueue] = useState<TodayAction[]>([]);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    todayApi
      .queue()
      .then((res) => {
        if (alive) {
          setActionQueue(res.actions ?? []);
          setQueueLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setQueueLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const runAction = (a: TodayAction) => {
    if (a.ask_prompt) {
      // Open the dock if it's collapsed so the run is visible, then
      // queue the prompt through the same ask-stream pipeline the dock
      // composer uses. We don't await — sendAsk owns its own streaming
      // state via the dock store.
      useDock.getState().open();
      void sendAsk(a.ask_prompt, [], { surface: "dock" });
    }
    if (a.route) router.push(a.route);
  };

  const fitColor = (m: number) => (m >= 90 ? "#4C7A3F" : m >= 85 ? "#5D3000" : "#A66A00");
  const fitBg = (m: number) => (m >= 90 ? "#EBF3E5" : m >= 85 ? "#F5EDE3" : "#F8ECD6");
  const fitLabel = (m: number) =>
    m >= 95 ? t("fit.excellent") : m >= 90 ? t("fit.strong") : m >= 85 ? t("fit.good") : t("fit.fair");

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
        <div className="stat-cell flex-1 px-[22px] py-[18px]">
          <div key={totalJobs} className="num-rise font-display font-bold text-[26px] text-ink tabular-nums">{totalJobs}</div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            {t("rolesInDatabase", { count: totalJobs })}
          </div>
        </div>
        <div className="w-px bg-border" />
        <div className="stat-cell flex-1 px-[22px] py-[18px]">
          <div key={`${anyScored}-${strongFits}`} className={`num-rise font-display font-bold text-[26px] tabular-nums ${anyScored ? "text-green" : "text-ink-muted"}`} style={{ animationDelay: "0.07s" }}>
            {anyScored ? strongFits : "—"}
          </div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            {!anyScored
              ? t("noFitsScored")
              : strongFits === 0
                ? t("noStrongFits")
                : t("strongFitsReady", { count: strongFits })}
          </div>
        </div>
        <div className="w-px bg-border" />
        <div className="stat-cell flex-1 px-[22px] py-[18px]">
          <div key={trackedSkills} className="num-rise font-display font-bold text-[26px] text-amber tabular-nums" style={{ animationDelay: "0.14s" }}>{trackedSkills}</div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            {t("trendingSkillsTracked", { count: trackedSkills })}
          </div>
        </div>
      </div>

      {actionQueue.length > 0 && (
        <div className="mb-[34px]">
          <div className="flex items-baseline justify-between mb-[14px]">
            <h2 className="font-display font-bold text-[13px] tracking-[1.5px] uppercase text-ink-light m-0">
              {t("queueHeading", { count: actionQueue.length })}
            </h2>
            <span className="font-body text-[13px] text-ink-muted">{t("tapToStart")}</span>
          </div>
          <ol className="flex flex-col gap-[10px] list-none m-0 p-0">
            {actionQueue.map((a, i) => (
              <li
                key={a.id}
                className="animate-step-in"
                style={{ animationDelay: `${0.05 + i * 0.06}s` }}
              >
                <button
                  type="button"
                  onClick={() => runAction(a)}
                  className="group w-full text-left bg-white border border-border rounded-[12px] px-[16px] py-[13px] shadow-sm hover:border-brown hover:shadow-[0_6px_16px_-8px_rgba(61,42,20,0.28)] transition-all duration-200 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[0.995] flex items-center gap-[14px] cursor-pointer"
                >
                  <span className="font-mono text-[10px] tracking-[0.8px] text-ink-muted w-[18px] flex-shrink-0 transition-colors duration-200 group-hover:text-brown">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-body font-semibold text-[14px] text-ink leading-tight">
                      {a.title}
                    </span>
                    <span className="block font-body text-[12.5px] text-ink-light mt-[2px]">
                      {a.sub}
                    </span>
                    <span
                      className="block font-mono mt-[4px]"
                      style={{
                        fontSize: 9.5,
                        letterSpacing: 0.6,
                        textTransform: "uppercase",
                        color: "#A38A60",
                      }}
                    >
                      {t("whyThis", { reason: whyThisCard(a, t) })}
                    </span>
                  </span>
                  <ActionKindPill kind={a.kind} t={t} />
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {queueLoaded && actionQueue.length === 0 && (
        // TODAY2 (round-12): the round-12 onboarding audit found that a
        // brand-new account hit /app/today and saw a passive line —
        // "applications, interviews and learn signals will surface here
        // automatically" — which reads as "the service is broken" when
        // the queue is empty *because the user hasn't uploaded anything
        // yet*. Branch the copy on whether we know about a résumé: if
        // we don't, surface a single concrete next step; if we do, the
        // original passive line still applies (the queue really will
        // populate as the user starts applying / scheduling interviews).
        !parsedResume ? (
          <div className="mb-[34px] flex items-start gap-3 rounded-[14px] border border-cream-border bg-cream px-[18px] py-[14px]">
            <div className="font-body text-[13.5px] text-ink-dark flex-1">
              <span className="font-semibold">{t("emptyResumeTitle")}</span>{" "}
              {t("emptyResumeBody")}
            </div>
            <button
              type="button"
              onClick={() => router.push("/app/studio/resume")}
              className="font-body text-[13px] font-semibold text-paper bg-brown rounded-[8px] px-3 py-2 hover:bg-brown-light transition-colors whitespace-nowrap"
            >
              {t("uploadResume")}
            </button>
          </div>
        ) : (
          <div className="mb-[34px] font-body text-[13px] text-ink-muted">
            {t("emptyQueuePassive")}
          </div>
        )
      )}

      {apiJobs.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mb-[14px]">
            <h2 className="font-display font-bold text-[13px] tracking-[1.5px] uppercase text-ink-light m-0">
              {t("liveMatches")}
            </h2>
            {/* Only claim "sorted by fit" when the matcher has actually scored
                something. Otherwise the label fights the uniform "Not scored"
                tags below it (QA bug #2). */}
            <span className="font-body text-[13px] text-ink-muted">
              {anyScored ? t("fromDbSorted") : t("fromDbPending")}
            </span>
          </div>
          <div className="flex flex-col gap-[13px] mb-[34px]">
            {apiJobs.map((job) => (
              <ApiJobCard key={job.id} job={job} onApply={(id) => openReview(id)} t={t} />
            ))}
          </div>
        </>
      )}

      {apiJobsLoading && apiJobs.length === 0 && (
        <div className="flex flex-col gap-[10px] mb-[34px]">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px]"
            >
              <div className="skeleton w-[46px] h-[46px] rounded-[11px]" />
              <div className="flex-1 flex flex-col gap-[7px]">
                <div className="skeleton h-[14px] w-[60%] rounded" />
                <div className="skeleton h-[10px] w-[40%] rounded" />
                <div className="skeleton h-[6px] w-[30%] rounded-full mt-[4px]" />
              </div>
              <div className="skeleton w-[120px] h-[36px] rounded-[9px]" />
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
              {t("whileWeLook")}
            </h2>
            <span className="font-body text-[13px] text-ink-muted flex items-center gap-1">
              <Sparkles className="w-[13px] h-[13px] text-amber" strokeWidth={1.7} /> {t("sampleSurface")}
            </span>
          </div>

          <div className="flex flex-col gap-[13px]">
        {JOBS.map((job) => (
          <div
            key={job.id}
            className="group lift bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px] hover:border-border-dark"
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
                <div className="bar-track w-[120px] h-[6px] rounded-full bg-border overflow-hidden">
                  <div
                    className="bar-fill h-full rounded-full bg-[linear-gradient(90deg,#4C7A3F,#5E9B4D)]"
                    style={{ width: `${job.match}%` }}
                  />
                </div>
                <span className="font-mono text-[11px] font-medium text-green">
                  {t("percentMatch", { pct: job.match })}
                </span>
              </div>
            </div>
            <div className="shrink-0">
              {job.ready ? (
                <button
                  onClick={() => openReview(job.id)}
                  className="tap border-none cursor-pointer bg-brown text-paper font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap shadow-[0_1px_2px_rgba(61,42,20,0.18)] hover:bg-brown-light hover:shadow-[0_6px_16px_-6px_rgba(61,42,20,0.5)] transition-[background-color,box-shadow,transform] duration-200 ease-out"
                >
                  <Zap className="w-[15px] h-[15px] transition-transform duration-300 ease-out group-hover:rotate-[-8deg] group-hover:scale-110" strokeWidth={1.9} />
                  {t("oneClickApply")}
                </button>
              ) : (
                <button
                  onClick={() => openExtension(job.id)}
                  className="tap group/site cursor-pointer bg-white text-ink border border-border-dark font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap hover:border-brown hover:shadow-[0_6px_16px_-8px_rgba(61,42,20,0.28)] transition-[border-color,box-shadow,transform] duration-200 ease-out"
                >
                  {t("applyOnSite")}
                  <ArrowUpRight className="w-[14px] h-[14px] text-ink-light transition-transform duration-300 ease-out group-hover/site:translate-x-0.5 group-hover/site:-translate-y-0.5" strokeWidth={1.9} />
                </button>
              )}
            </div>
          </div>
        ))}
          </div>

          <div className="mt-5 flex items-center gap-[9px] justify-center font-body text-[13px] text-ink-muted">
            <Clock className="w-[15px] h-[15px]" strokeWidth={1.7} />
            {t("buttonsHint")}
          </div>
        </>
      )}
    </div>
  );
}
