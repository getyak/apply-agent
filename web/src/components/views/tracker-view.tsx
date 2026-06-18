"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { useVantage, type ApiApplication, type Applied } from "@/lib/store";
import { statusVisual, type AppColumn } from "@/lib/status";
import { Sparkles, Inbox, Compass, ArrowRight } from "lucide-react";

/** Row shape rendered in any column. Unifies the demo "applied" entries (kept
 *  for the empty-state seed during dev) and real API applications under a
 *  single shape so the kanban column is identical regardless of source. */
interface TrackerCard {
  key: string;
  /** Two-letter monogram for the company avatar. Derived if missing. */
  mono: string;
  company: string;
  role: string;
  /** Pre-formatted "when" stamp shown under the company name. */
  when: string;
  status: string;
  /** Demo "just submitted" highlight — only used by the seed entries. */
  isNew?: boolean;
}

const COLUMN_TITLES: Record<AppColumn, string> = {
  applied: "Applied",
  interviewing: "Interviewing",
  outcome: "Outcome",
};

const COLUMN_EMPTY_COPY: Record<AppColumn, string> = {
  applied: "Submit an application and it lands here.",
  interviewing: "When a recruiter replies, the conversation moves to this column.",
  outcome: "Offers and closed loops settle here.",
};

function monoFor(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return (parts[0]?.slice(0, 2) ?? "?").toUpperCase();
  }
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Best-effort "2d ago" / "Just now" formatter from an ISO timestamp. */
function relativeFrom(iso?: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMs = Date.now() - ts;
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

function appliedToCard(a: Applied, i: number): TrackerCard {
  return {
    key: `seed-${a.co}-${i}`,
    mono: a.mono,
    company: a.co,
    role: a.role,
    when: a.when,
    status: "submitted",
    isNew: a.isNew,
  };
}

function apiToCard(a: ApiApplication): TrackerCard {
  const company = a.company || "Unknown company";
  return {
    key: `api-${a.id}`,
    mono: monoFor(company),
    company,
    role: a.role_title || "Role",
    when: relativeFrom(a.submitted_at || a.created_at),
    status: a.status,
  };
}

function Column({
  title,
  cards,
  emptyCopy,
}: {
  title: string;
  cards: TrackerCard[];
  emptyCopy: string;
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-[14px] px-[2px]">
        <span className="font-display font-bold text-[12px] tracking-[1.2px] uppercase text-ink-light">
          {title}
        </span>
        <span className="font-mono text-[10px] text-ink-muted">{cards.length}</span>
      </div>

      {cards.length === 0 ? (
        <div className="bg-[#FBF8F3] border border-dashed border-border rounded-xl p-[18px] flex flex-col items-center text-center gap-[10px]">
          <div className="w-[34px] h-[34px] rounded-[9px] bg-white border border-border flex items-center justify-center">
            <Inbox className="w-[16px] h-[16px] text-ink-muted" strokeWidth={1.7} />
          </div>
          <div className="font-body text-[12.5px] leading-[1.5] text-ink-light">
            {emptyCopy}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-[11px]">
          {cards.map((card) => {
            const v = statusVisual(card.status);
            const highlight = card.isNew ? "border-green bg-green-bg/30 animate-pop" : "border-border";
            return (
              <div
                key={card.key}
                className={`bg-white border rounded-xl p-[15px] shadow-sm ${highlight}`}
              >
                <div className="flex items-center gap-[11px] mb-[10px]">
                  <div className="w-[34px] h-[34px] rounded-[9px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[14px] text-ink shrink-0">
                    {card.mono}
                  </div>
                  <div className="min-w-0">
                    <div className="font-body font-semibold text-[14px] text-ink truncate">
                      {card.role}
                    </div>
                    <div className="font-body text-[12px] text-ink-light truncate">
                      {card.company}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] tracking-[0.4px] uppercase text-ink-muted">
                    {card.when}
                  </span>
                  <span
                    className={`font-mono text-[9px] tracking-[0.5px] uppercase px-[7px] py-[3px] rounded ${v.pillClass}`}
                  >
                    {card.isNew ? "Just sent" : v.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TrackerView() {
  // Seed entries from the demo onboarding path — kept ONLY until the user
  // submits their first real application. Once any API application lands the
  // seeds are dropped from the board so columns are exclusively real.
  const applied = useVantage((s) => s.applied);
  const openPrep = useVantage((s) => s.openPrep);
  // Fall back to [] so a transient undefined (mid-rehydrate, before first
  // loadApplications resolves) can never blow up `.length` / `.map`.
  const apiApplications = useVantage((s) => s.apiApplications ?? []);
  const loadApplications = useVantage((s) => s.loadApplications);
  const apiAppsLoading = useVantage((s) => s.apiAppsLoading);

  useEffect(() => {
    loadApplications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = useMemo<Record<AppColumn, TrackerCard[]>>(() => {
    const buckets: Record<AppColumn, TrackerCard[]> = {
      applied: [],
      interviewing: [],
      outcome: [],
    };
    apiApplications.forEach((a) => {
      buckets[statusVisual(a.status).column].push(apiToCard(a));
    });
    if (apiApplications.length === 0) {
      applied.forEach((a, i) => buckets.applied.push(appliedToCard(a, i)));
    }
    return buckets;
  }, [apiApplications, applied]);

  const totalReal = apiApplications.length;
  const hasInterviewing = cards.interviewing.length > 0;

  return (
    <div className="px-12 pt-10 pb-[60px] animate-fade-up">
      <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-[10px]">
        Pipeline
      </div>
      <div className="flex items-baseline justify-between mb-[26px] gap-4 flex-wrap">
        <h1 className="font-display font-bold text-[32px] -tracking-[0.3px] text-ink m-0">
          Applications
        </h1>
        <span className="font-body text-[13px] text-ink-muted">
          {apiAppsLoading
            ? "Syncing with database…"
            : totalReal === 0
              ? "Nothing submitted yet — your seed flow is below."
              : `${totalReal} ${totalReal === 1 ? "application" : "applications"} tracked`}
        </span>
      </div>

      {hasInterviewing && (
        <div className="mb-6 flex items-center gap-3 bg-gold-bg border border-cream-border rounded-[13px] px-4 py-3">
          <Sparkles className="w-[16px] h-[16px] text-amber" strokeWidth={1.8} />
          <span className="font-body text-[13.5px] text-brown flex-1">
            You have {cards.interviewing.length} active {cards.interviewing.length === 1 ? "interview" : "interviews"}.
            Click <strong className="font-semibold">Prep this interview</strong> to launch a mock.
          </span>
          <button
            type="button"
            onClick={() => openPrep(0)}
            className="cursor-pointer border-none bg-brown text-paper font-body font-semibold text-[12.5px] px-[14px] py-[7px] rounded-[8px] hover:bg-brown-light transition-colors"
          >
            Open prep
          </button>
        </div>
      )}

      {/* First-time empty state — only when we've finished loading AND have
          zero real applications. The seed cards under "Applied" stay as a
          visual scaffold; this banner is the load-bearing CTA that explains
          the column is genuinely empty and points to where matches live. */}
      {!apiAppsLoading && totalReal === 0 && (
        <div className="mb-6 flex items-start gap-3 bg-cream border border-cream-border rounded-[13px] px-4 py-4">
          <div className="w-[34px] h-[34px] rounded-[9px] bg-white border border-cream-border flex items-center justify-center shrink-0">
            <Compass className="w-[16px] h-[16px] text-brown" strokeWidth={1.7} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-body font-semibold text-[13.5px] text-ink">
              Nothing here yet — pick a role from today&apos;s matches to begin.
            </div>
            <div className="font-body text-[12.5px] text-ink-light mt-[3px]">
              Once you tailor and submit your first application, this board fills
              with real activity. The cards below are a preview only.
            </div>
          </div>
          <Link
            href="/app/today"
            className="shrink-0 inline-flex items-center gap-[6px] no-underline border-none bg-brown text-paper font-body font-semibold text-[12.5px] px-[14px] py-[7px] rounded-[8px] hover:bg-brown-light transition-colors"
          >
            Browse matches
            <ArrowRight className="w-[13px] h-[13px]" strokeWidth={2} />
          </Link>
        </div>
      )}

      <div className="flex gap-[18px] items-start">
        <Column
          title={COLUMN_TITLES.applied}
          cards={cards.applied}
          emptyCopy={COLUMN_EMPTY_COPY.applied}
        />
        <Column
          title={COLUMN_TITLES.interviewing}
          cards={cards.interviewing}
          emptyCopy={COLUMN_EMPTY_COPY.interviewing}
        />
        <Column
          title={COLUMN_TITLES.outcome}
          cards={cards.outcome}
          emptyCopy={COLUMN_EMPTY_COPY.outcome}
        />
      </div>
    </div>
  );
}
