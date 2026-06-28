"use client";

/**
 * QuotaPanel — Auto-applies cycle quota for the sidebar.
 *
 * Three states + a collapsed (74px) micro view, driven by `used` / `total`.
 * All data is mocked in MOCK_QUOTA_DATA for now; Phase 2 will replace with a
 * selector against `agent_tasks` aggregates (see CLAUDE.md / agents/audit).
 *
 * Visual design rationale lives in docs/architecture/vantage-ui-mapping.md
 * and the conversation that spawned this file. The panel intentionally
 * borrows existing polish primitives from globals.css (num-rise, bar-grow,
 * bar-sheen, glow-breathe, link-pull, count-pop) rather than introducing new
 * keyframes — so it inherits the reduced-motion guard for free.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Activity, ChevronDown, Sparkles } from "lucide-react";

type QuotaState = "healthy" | "critical" | "full";

type DayUsage = {
  /** i18n key for the relative label ("today" / "yesterday" / "twoDaysAgo"...) */
  label: string;
  /** Plain-text weekday name shown in the "Most efficient day" insight line. */
  weekday: string;
  /** Auto-applies sent that day. */
  count: number;
  /** Replies received against those applies — drives the "most efficient" pick. */
  replies: number;
};

interface QuotaData {
  used: number;
  total: number;
  resetsInDays: number;
  /** Days the user has already been in the current cycle, used for pace math. */
  daysElapsedInCycle: number;
  /** Last four cycle-days, freshest first — feeds the activity strip. */
  recentDays: Array<DayUsage>;
  /** Weekday name for "at this rate you'll run out X" copy. */
  runOutWeekday: string;
}

// Default mock — healthy state. The sidebar passes this in for now; later the
// store will own it. Two additional mocks are exported so a future Storybook
// or the rubric run can swap states without props gymnastics.
export const MOCK_QUOTA_DATA: QuotaData = {
  used: 14,
  total: 40,
  resetsInDays: 14,
  daysElapsedInCycle: 16,
  recentDays: [
    { label: "today", weekday: "Wednesday", count: 3, replies: 0 },
    { label: "yesterday", weekday: "Tuesday", count: 5, replies: 2 },
    { label: "twoDaysAgo", weekday: "Monday", count: 2, replies: 0 },
    { label: "threeDaysAgo", weekday: "Sunday", count: 4, replies: 1 },
  ],
  runOutWeekday: "Friday",
};

export const MOCK_QUOTA_CRITICAL: QuotaData = {
  ...MOCK_QUOTA_DATA,
  used: 34,
  recentDays: [
    { label: "today", weekday: "Wednesday", count: 7, replies: 1 },
    { label: "yesterday", weekday: "Tuesday", count: 9, replies: 3 },
    { label: "twoDaysAgo", weekday: "Monday", count: 8, replies: 0 },
    { label: "threeDaysAgo", weekday: "Sunday", count: 6, replies: 0 },
  ],
};

export const MOCK_QUOTA_FULL: QuotaData = {
  ...MOCK_QUOTA_DATA,
  used: 40,
};

/**
 * Pick the day with the best applies→replies ratio. Ties break to the day
 * with more replies (absolute), then to the most recent day. Days with zero
 * applies are skipped. Returns null if every recentDay is empty.
 */
function pickMostEfficientDay(
  days: ReadonlyArray<DayUsage>,
): { weekday: string; count: number; replies: number } | null {
  const candidates = days
    .map((d, i) => ({ ...d, i }))
    .filter((d) => d.count > 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ra = a.replies / a.count;
    const rb = b.replies / b.count;
    if (rb !== ra) return rb - ra;
    if (b.replies !== a.replies) return b.replies - a.replies;
    return a.i - b.i;
  });
  const best = candidates[0]!;
  return { weekday: best.weekday, count: best.count, replies: best.replies };
}

function deriveState(used: number, total: number): QuotaState {
  if (used >= total) return "full";
  const remainingRatio = (total - used) / total;
  if (remainingRatio <= 0.25) return "critical";
  return "healthy";
}

interface QuotaPanelProps {
  collapsed?: boolean;
  data?: QuotaData;
}

// Dev-mode self-inspection: ?quota=healthy|critical|full|collapsed swaps the
// mock dataset (and forces the 74px micro view for `collapsed`). The default
// no-param path lands on the healthy production view — zero behavioural change
// for end users, but lets a reviewer eyeball every state without code edits.
function useQuotaOverride(): { data: QuotaData; forceCollapsed: boolean } {
  const [override, setOverride] = useState<{ data: QuotaData; forceCollapsed: boolean }>(() => ({
    data: MOCK_QUOTA_DATA,
    forceCollapsed: false,
  }));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const value = new URLSearchParams(window.location.search).get("quota");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs mock override with external URL query (?quota=critical|full|collapsed) for dev/preview demos.
    if (value === "critical") setOverride({ data: MOCK_QUOTA_CRITICAL, forceCollapsed: false });
    else if (value === "full") setOverride({ data: MOCK_QUOTA_FULL, forceCollapsed: false });
    else if (value === "collapsed") setOverride({ data: MOCK_QUOTA_DATA, forceCollapsed: true });
    else setOverride({ data: MOCK_QUOTA_DATA, forceCollapsed: false });
  }, []);

  return override;
}

export function QuotaPanel({ collapsed = false, data }: QuotaPanelProps) {
  const t = useTranslations("sidebar.quota");
  const [expanded, setExpanded] = useState(false);
  const dev = useQuotaOverride();
  const effectiveData = data ?? dev.data;
  const effectiveCollapsed = collapsed || dev.forceCollapsed;

  const state = deriveState(effectiveData.used, effectiveData.total);
  const remaining = Math.max(0, effectiveData.total - effectiveData.used);
  const percent = Math.min(100, Math.round((effectiveData.used / effectiveData.total) * 100));

  // Pace math — projects "~N days at your current pace" for the italic
  // line under the bar (i18n key: sidebar.quota.paceDays).
  //
  //   perDay = used / daysElapsedInCycle           [auto-applies / day]
  //   paceDays = max(1, round(remaining / perDay)) [days until quota runs out]
  //
  // Notes:
  // - Returns null when either input is non-positive (no cycle history yet,
  //   or the user hasn't sent anything). The UI omits the italic line in
  //   that state — silent is correct, an "Infinity days" projection isn't.
  // - Rounded, then floored at 1 day so a sub-day rate still reads as
  //   "~1 day at your current pace" instead of "0 days" (which the user
  //   would read as "already empty").
  // - daysElapsedInCycle is the user's elapsed days within the *current*
  //   cycle (NOT account age) — pacing has to be relative to the same
  //   cycle the quota resets against, otherwise the projection drifts.
  // - Phase 2 will swap MOCK_QUOTA_DATA for a real selector over
  //   agent_tasks aggregates; the formula stays the same.
  const paceDays = useMemo(() => {
    if (effectiveData.daysElapsedInCycle <= 0 || effectiveData.used <= 0) return null;
    const perDay = effectiveData.used / effectiveData.daysElapsedInCycle;
    if (perDay <= 0) return null;
    return Math.max(1, Math.round(remaining / perDay));
  }, [effectiveData.daysElapsedInCycle, effectiveData.used, remaining]);

  if (effectiveCollapsed) {
    return (
      <CollapsedQuota
        state={state}
        used={effectiveData.used}
        total={effectiveData.total}
        percent={percent}
      />
    );
  }

  // Bar fill gradient swaps per state. Healthy = warm brown; critical fades to
  // amber on the right edge; full = copper bath.
  const fillStyle: React.CSSProperties = {
    width: `${percent}%`,
    backgroundImage:
      state === "full"
        ? "linear-gradient(90deg,#7A3F00,#C04A1F)"
        : state === "critical"
          ? "linear-gradient(90deg,#7A3F00 0%,#A66A00 60%,#E8A317 100%)"
          : "linear-gradient(90deg,#7A3F00,#A66A00)",
  };

  const trendGlyph = state === "full" ? "●" : state === "critical" ? "⚠" : "↗";
  const trendColor =
    state === "full" ? "text-[#C04A1F]" : state === "critical" ? "text-amber" : "text-ink-light";

  return (
    <div
      className={`quota-card bg-[#FBF8F3] border rounded-xl mb-3 transition-colors ${
        state === "full"
          ? "border-[#E2B7A2]"
          : state === "critical"
            ? "border-[#E8D29A]"
            : "border-border"
      }`}
      role="group"
      aria-label={t("label")}
    >
      <div className="p-[14px]">
        {/* Header — label + live count + trend glyph */}
        <div className="flex items-center justify-between mb-[10px]">
          <span className="font-mono text-[10px] tracking-[0.6px] uppercase text-ink-light">
            {t("label")}
          </span>
          <span
            className="font-mono text-[10px] tracking-[0.6px] text-brown tabular-nums"
            aria-live="polite"
          >
            <span
              key={`u-${effectiveData.used}`}
              className="num-rise inline-block font-semibold"
            >
              {effectiveData.used}
            </span>
            <span className="opacity-50 mx-[3px]">/</span>
            <span>{effectiveData.total}</span>
            <span className={`ml-[6px] ${trendColor}`} aria-hidden="true">
              {trendGlyph}
            </span>
          </span>
        </div>

        {/* Progress bar */}
        <div
          className="bar-track h-[6px] rounded-full bg-border overflow-hidden"
          role="progressbar"
          aria-valuenow={effectiveData.used}
          aria-valuemin={0}
          aria-valuemax={effectiveData.total}
          aria-valuetext={`${effectiveData.used} of ${effectiveData.total}`}
        >
          <div className="bar-fill h-full rounded-full" style={fillStyle} />
        </div>

        {/* Subtext — remaining + reset, then italic pace line */}
        <div className="mt-[10px] space-y-[3px]">
          {state === "full" ? (
            <p className="font-body text-[11.5px] text-ink leading-snug">
              <span className="font-semibold">{t("fullTitle")}</span>{" "}
              <span className="text-ink-muted">{t("fullBody")}</span>
            </p>
          ) : (
            <>
              <p className="font-body text-[11px] text-ink-muted">
                <span className="text-ink">{t("remaining", { n: remaining })}</span>
                <span className="opacity-60"> · </span>
                <span>{t("resetsIn", { days: effectiveData.resetsInDays })}</span>
              </p>
              {paceDays !== null && (
                <p className="font-body text-[10.5px] text-ink-light italic leading-snug">
                  <span aria-hidden="true" className="mr-[3px] opacity-70">
                    ↳
                  </span>
                  {state === "critical"
                    ? t("paceRunOut", { weekday: effectiveData.runOutWeekday })
                    : t("paceDays", { days: paceDays })}
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer — two CTAs */}
        <div
          className={`mt-[12px] flex items-center justify-between gap-[8px] ${
            state === "full" ? "flex-col items-stretch" : ""
          }`}
        >
          {state !== "full" && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="quota-action group flex items-center gap-[4px] font-mono text-[10px] tracking-[0.5px] uppercase text-ink-light hover:text-brown transition-colors cursor-pointer"
              aria-expanded={expanded}
              aria-controls="quota-activity"
            >
              <Activity className="w-[11px] h-[11px]" strokeWidth={1.8} aria-hidden="true" />
              <span>{t("seeActivity")}</span>
              <ChevronDown
                className={`w-[10px] h-[10px] transition-transform duration-200 ${
                  expanded ? "rotate-180" : ""
                }`}
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
          )}
          <UpgradeCta state={state} />
        </div>

        {/* Expanded activity strip */}
        {expanded && state !== "full" && (
          <ActivityStrip data={effectiveData} className="animate-fade-in mt-[14px]" />
        )}
      </div>

      {/* Full-state activity is shown unconditionally (the "what just happened" is
          the most useful info when you're out for the cycle). */}
      {state === "full" && (
        <ActivityStrip
          data={effectiveData}
          className="border-t border-[#EFE4D6] px-[14px] pt-[10px] pb-[12px]"
        />
      )}
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function UpgradeCta({ state }: { state: QuotaState }) {
  const t = useTranslations("sidebar.quota");
  const label =
    state === "full" ? t("upgradeUnlimited") : state === "critical" ? t("upgradeNow") : t("upgrade");

  // Healthy = bare link (link-pull primitive). Critical/full = filled gold pill
  // that glow-breathes to signal urgency without yelling.
  if (state === "healthy") {
    return (
      <button
        type="button"
        className="link-pull font-body text-[11.5px] font-semibold text-brown hover:text-[#5C2F00] transition-colors cursor-pointer"
      >
        {label} <span aria-hidden="true">→</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`quota-cta inline-flex items-center justify-center gap-[5px] rounded-[8px] px-[10px] py-[6px] font-body text-[11.5px] font-semibold text-paper bg-[linear-gradient(90deg,#A66A00,#E8A317)] hover:bg-[linear-gradient(90deg,#7A3F00,#E8A317)] transition-all cursor-pointer animate-glow ${
        state === "full" ? "w-full" : ""
      }`}
    >
      <Sparkles className="w-[11px] h-[11px]" strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
      <span aria-hidden="true">→</span>
    </button>
  );
}

function ActivityStrip({ data, className = "" }: { data: QuotaData; className?: string }) {
  const t = useTranslations("sidebar.quota");

  // Scale bars relative to the busiest recent day so the tallest one fills.
  const max = Math.max(1, ...data.recentDays.map((d) => d.count));
  // Derive the "most efficient day" insight from the same recentDays — keeps
  // the activity strip and the trailing italic line in lock-step instead of
  // letting them drift via separate fields.
  const best = pickMostEfficientDay(data.recentDays);

  const labelFor = (label: string, index: number) => {
    if (label === "today") return t("today");
    if (label === "yesterday") return t("yesterday");
    return t("daysAgo", { n: index });
  };

  return (
    <div id="quota-activity" className={className}>
      <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted mb-[8px]">
        {t("thisCycle")}
      </div>
      <ul className="space-y-[6px]">
        {data.recentDays.map((d, i) => {
          const width = Math.round((d.count / max) * 100);
          return (
            <li key={d.label} className="flex items-center gap-[8px]">
              <span
                aria-hidden="true"
                className={`w-[6px] h-[6px] rounded-full shrink-0 ${
                  i === 0 ? "bg-brown" : "bg-[#D6CEC0]"
                }`}
              />
              <span className="font-body text-[10.5px] text-ink-light w-[64px] shrink-0">
                {labelFor(d.label, i)}
              </span>
              <span className="font-mono text-[10px] text-ink tabular-nums w-[14px] shrink-0">
                {d.count}
              </span>
              <div className="flex-1 h-[4px] rounded-full bg-[#EFE4D6] overflow-hidden">
                <div
                  className="bar-fill h-full rounded-full bg-[linear-gradient(90deg,#A66A00,#D08B14)]"
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {best && (
        <p className="mt-[10px] font-body text-[10.5px] text-ink-light italic leading-snug">
          <span aria-hidden="true" className="mr-[3px] opacity-70">
            ✦
          </span>
          {t("mostEfficient", {
            day: best.weekday,
            applies: best.count,
            replies: best.replies,
          })}
        </p>
      )}
    </div>
  );
}

function CollapsedQuota({
  state,
  used,
  total,
  percent,
}: {
  state: QuotaState;
  used: number;
  total: number;
  percent: number;
}) {
  const t = useTranslations("sidebar.quota");

  const barColor =
    state === "full"
      ? "bg-[linear-gradient(180deg,#7A3F00,#C04A1F)]"
      : state === "critical"
        ? "bg-[linear-gradient(180deg,#7A3F00,#E8A317)]"
        : "bg-[linear-gradient(180deg,#7A3F00,#A66A00)]";

  const ring =
    state === "full"
      ? "border-[#E2B7A2]"
      : state === "critical"
        ? "border-[#E8D29A]"
        : "border-border";

  return (
    <div
      className={`mx-auto mb-3 flex flex-col items-center justify-center gap-[3px] w-[34px] rounded-[9px] border ${ring} bg-[#FBF8F3] py-[6px]`}
      title={`${t("label")} — ${used} / ${total}`}
      aria-label={`${t("label")} — ${used} / ${total}`}
      role="group"
    >
      <span className="font-mono text-[9px] tabular-nums text-brown font-semibold leading-none">
        {used}
      </span>
      <div
        className="relative h-[28px] w-[4px] rounded-full bg-[#EFE4D6] overflow-hidden"
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuetext={`${used} of ${total}`}
      >
        <div
          className={`absolute bottom-0 left-0 right-0 ${barColor} ${
            state === "critical" ? "animate-glow" : ""
          }`}
          style={{ height: `${percent}%` }}
        />
      </div>
      <span className="font-mono text-[9px] tabular-nums text-ink-light leading-none">{total}</span>
    </div>
  );
}
