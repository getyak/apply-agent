"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useVantage, type ApiApplication, type Applied } from "@/lib/store";
import { statusVisual, type AppColumn } from "@/lib/status";
import { Sparkles, Inbox, Compass, ArrowRight, X } from "lucide-react";

/** Row shape rendered in any column. Unifies the demo "applied" entries (kept
 *  for the empty-state seed during dev) and real API applications under a
 *  single shape so the kanban column is identical regardless of source. */
interface TrackerCard {
  key: string;
  /** Real application id when this card maps to an ApiApplication; null for
   *  seed cards (which are not draggable / clickable into the drawer). */
  applicationId: string | null;
  /** Two-letter monogram for the company avatar. Derived if missing. */
  mono: string;
  company: string;
  role: string;
  /** Pre-formatted "when" stamp shown under the company name. */
  when: string;
  status: string;
  /** Demo "just submitted" highlight — only used by the seed entries. */
  isNew?: boolean;
  /** P3.2 — what the user should do next on this row. Prefers the
   *  persisted column; falls back to the API-derived value. */
  nextAction?: string | null;
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

// Reverse mapping: the canonical status we PATCH to when a card is dropped
// into a column. status.ts → kanban column is many-to-one (e.g. screen and
// onsite both live in interviewing); when the user drags ACROSS columns we
// pick the column's canonical status. Dropping in the source column is a
// no-op handled before this map is consulted.
const COLUMN_DEFAULT_STATUS: Record<AppColumn, string> = {
  applied: "submitted",
  interviewing: "interview",
  // Outcome is genuinely ambiguous (offer vs rejected vs ghosted). We pick
  // "rejected" as the default because the most common drag-to-outcome action
  // is closing a ghosted thread; the drawer lets the user upgrade to "offer"
  // explicitly. This is a debatable choice — see comment near onDrop().
  outcome: "rejected",
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
function relativeFrom(iso?: string | null): string {
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

// Compact "what's next on this row" chip (P3.2). Distinct color tracks
// per action kind so the user can scan the column for "anything urgent
// I need to do today" without reading every card.
function NextActionBadge({ value }: { value: string }) {
  const spec = (() => {
    if (value === "interview") return { text: "INTERVIEW", fg: "#7A2A1F", bg: "#F4D7D2" };
    if (value === "follow_up") return { text: "FOLLOW UP", fg: "#8A6A12", bg: "#FBEFD0" };
    if (value === "submit") return { text: "READY", fg: "#2F5722", bg: "#E2EED9" };
    if (value === "prep") return { text: "PREP", fg: "#5D3000", bg: "#FBEFD8" };
    if (value === "close_loop") return { text: "WRAP UP", fg: "#5D5046", bg: "#F4F0E8" };
    return null;
  })();
  if (!spec) return null;
  return (
    <span
      style={{
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 9,
        letterSpacing: 0.5,
        padding: "3px 7px",
        borderRadius: 4,
        color: spec.fg,
        background: spec.bg,
      }}
    >
      {spec.text}
    </span>
  );
}

function appliedToCard(a: Applied, i: number): TrackerCard {
  return {
    key: `seed-${a.co}-${i}`,
    applicationId: null,
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
    applicationId: a.id,
    mono: monoFor(company),
    company,
    role: a.role_title || "Role",
    when: relativeFrom(a.submitted_at || a.created_at),
    status: a.status,
    nextAction: a.next_action ?? a.next_action_derived ?? null,
  };
}

// ─── Kanban column ─────────────────────────────────────────────────────

function Column({
  column,
  title,
  cards,
  emptyCopy,
  isDropTarget,
  isHovered,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardPick,
  onCardDragStart,
  onCardDragEnd,
  draggingId,
}: {
  column: AppColumn;
  title: string;
  cards: TrackerCard[];
  emptyCopy: string;
  isDropTarget: boolean;
  isHovered: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onCardPick: (id: string) => void;
  onCardDragStart: (id: string, status: string) => void;
  onCardDragEnd: () => void;
  draggingId: string | null;
}) {
  const dropHighlight = isHovered
    ? "border-brown bg-cream/60"
    : isDropTarget
      ? "border-cream-border bg-[#FBF8F3]/40"
      : "border-transparent";

  return (
    <div
      className={`flex-1 min-w-0 border-2 border-dashed rounded-[14px] p-[6px] transition-colors ${dropHighlight}`}
      data-column={column}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
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
            const highlight = card.isNew
              ? "border-green bg-green-bg/30 animate-pop"
              : "border-border";
            const draggable = card.applicationId !== null;
            const isDragging =
              draggingId !== null && card.applicationId === draggingId;
            return (
              <button
                key={card.key}
                type="button"
                draggable={draggable}
                onDragStart={(e) => {
                  if (!card.applicationId) return;
                  e.dataTransfer.effectAllowed = "move";
                  // Carry the row id + current status on the drag so the column
                  // drop handler can skip the PATCH on a same-column drop.
                  e.dataTransfer.setData("text/plain", card.applicationId);
                  e.dataTransfer.setData("application/x-relay-app-id", card.applicationId);
                  e.dataTransfer.setData("application/x-relay-app-status", card.status);
                  onCardDragStart(card.applicationId, card.status);
                }}
                onDragEnd={onCardDragEnd}
                onClick={() => {
                  if (card.applicationId) onCardPick(card.applicationId);
                }}
                disabled={!card.applicationId}
                aria-label={`Open ${card.role} at ${card.company}`}
                className={`block w-full text-left bg-white border rounded-xl p-[15px] shadow-sm transition-all ${highlight} ${
                  card.applicationId
                    ? "cursor-pointer hover:border-brown-light hover:shadow-md"
                    : "cursor-default opacity-90"
                } ${isDragging ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-[11px] mb-[10px]">
                  <div className="w-[34px] h-[34px] rounded-[9px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[14px] text-ink shrink-0">
                    {card.mono}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-body font-semibold text-[14px] text-ink truncate">
                      {card.role}
                    </div>
                    <div className="font-body text-[12px] text-ink-light truncate">
                      {card.company}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-[6px] flex-wrap">
                  <span className="font-mono text-[10px] tracking-[0.4px] uppercase text-ink-muted">
                    {card.when}
                  </span>
                  <div className="flex items-center gap-[5px]">
                    {card.nextAction ? <NextActionBadge value={card.nextAction} /> : null}
                    <span
                      className={`font-mono text-[9px] tracking-[0.5px] uppercase px-[7px] py-[3px] rounded ${v.pillClass}`}
                    >
                      {card.isNew ? "Just sent" : v.label}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Detail drawer ─────────────────────────────────────────────────────

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "draft", label: "Draft" },
  { value: "review", label: "In review" },
  { value: "submitted", label: "Submitted" },
  { value: "interview", label: "Interviewing" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "Rejected" },
  { value: "ghosted", label: "Ghosted" },
];

function DetailDrawer({
  application,
  onClose,
  onPatch,
  busy,
  errorMsg,
}: {
  application: ApiApplication;
  onClose: () => void;
  onPatch: (patch: { status?: string; outcome?: string; coverLetter?: string }) => void;
  busy: boolean;
  errorMsg: string | null;
}) {
  const v = statusVisual(application.status);
  // The drawer used to render inline inside TrackerView, whose ancestor
  // chain contains `animate-fade-up` (a residual `transform: matrix(...)`).
  // Any non-`none` transform on an ancestor hijacks the containing block of
  // a `position: fixed` child — so `fixed inset-0` was no longer relative
  // to the viewport. The panel height collapsed to the ancestor's intrinsic
  // height (~479px), the scroll area got squished, and the Cover-letter
  // section was clipped. Portalling to `document.body` lifts the dialog
  // out of that subtree entirely, restoring viewport-relative anchoring
  // and aligning with the WAI-ARIA pattern for modal dialogs.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="application-drawer-title"
      onClick={onClose}
      // `h-[100dvh]` belt-and-braces alongside `inset-0`: on mobile the
      // dynamic viewport unit survives URL bar collapse, which `100vh`
      // cannot. Doesn't hurt on desktop.
      className="fixed inset-0 h-[100dvh] bg-ink/40 z-50 flex justify-end animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] h-full bg-paper border-l border-border shadow-2xl flex flex-col"
      >
        <div className="flex items-start justify-between p-6 border-b border-border">
          <div className="min-w-0 flex-1 pr-3">
            <div className="font-mono text-[10px] tracking-[1px] uppercase text-ink-muted mb-2">
              Application
            </div>
            <h2
              id="application-drawer-title"
              className="font-display font-bold text-[20px] leading-[1.25] text-ink m-0"
            >
              {application.role_title || "Role"}
            </h2>
            <div className="font-body text-[13px] text-ink-light mt-1">
              {application.company || "Unknown company"}
            </div>
            <div className="flex items-center gap-3 mt-3">
              <span
                className={`font-mono text-[9px] tracking-[0.5px] uppercase px-[7px] py-[3px] rounded ${v.pillClass}`}
              >
                {v.label}
              </span>
              <span className="font-mono text-[10px] text-ink-muted">
                {application.submitted_at
                  ? `submitted ${relativeFrom(application.submitted_at)}`
                  : `created ${relativeFrom(application.created_at)}`}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-light hover:text-ink p-2 -m-2"
          >
            <X className="w-[18px] h-[18px]" strokeWidth={1.7} />
          </button>
        </div>

        {/* Scroll surface — `min-h-0` lets it actually shrink inside the
            flex column; trailing `pb-8` is the safety inset so the last
            section never touches the sticky footer (or kisses the bottom
            of the viewport when there's no error frame). */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 flex flex-col gap-6">
          {/* Status field — primary edit. Backed by PATCH ?status=. */}
          <section>
            <label className="block font-mono text-[10px] tracking-[1px] uppercase text-ink-muted mb-2">
              Status
            </label>
            <select
              value={application.status}
              disabled={busy}
              onChange={(e) => onPatch({ status: e.target.value })}
              className="w-full bg-white border border-border-dark rounded-[8px] px-3 py-2 font-body text-[14px] text-ink focus:outline-none focus:border-brown disabled:opacity-60"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="font-body text-[11px] text-ink-muted mt-2 leading-[1.5]">
              Moves the card between columns. The change saves immediately;
              if it fails, the previous status comes back.
            </div>
          </section>

          {/* Outcome — set on the way out. */}
          <section>
            <label
              htmlFor="application-outcome"
              className="block font-mono text-[10px] tracking-[1px] uppercase text-ink-muted mb-2"
            >
              Outcome (optional)
            </label>
            <input
              id="application-outcome"
              type="text"
              defaultValue={application.outcome ?? ""}
              placeholder="e.g. signed offer, closed at recruiter screen…"
              disabled={busy}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next === (application.outcome ?? "")) return;
                onPatch({ outcome: next });
              }}
              className="w-full bg-white border border-border-dark rounded-[8px] px-3 py-2 font-body text-[14px] text-ink focus:outline-none focus:border-brown disabled:opacity-60"
            />
            <div className="font-body text-[11px] text-ink-muted mt-2 leading-[1.5]">
              Narrative for what actually happened. Saved on blur.
            </div>
          </section>

          {/* Cover letter — long form. */}
          <section>
            <label
              htmlFor="application-cover"
              className="block font-mono text-[10px] tracking-[1px] uppercase text-ink-muted mb-2"
            >
              Cover letter draft
            </label>
            <textarea
              id="application-cover"
              defaultValue={application.cover_letter ?? ""}
              placeholder="Paste or write the cover letter you sent…"
              rows={8}
              disabled={busy}
              onBlur={(e) => {
                const next = e.target.value;
                if (next === (application.cover_letter ?? "")) return;
                onPatch({ coverLetter: next });
              }}
              className="w-full bg-white border border-border-dark rounded-[8px] px-3 py-2 font-body text-[14px] text-ink leading-[1.55] focus:outline-none focus:border-brown disabled:opacity-60 resize-y"
            />
          </section>

        </div>

        {/* Server feedback lives in its own non-scrolling footer slot so the
            user can always see PATCH failures even after scrolling the form
            content. Only rendered when there's something to say — no empty
            chrome otherwise. */}
        {errorMsg ? (
          <div className="border-t border-border bg-paper px-6 py-4">
            <div className="bg-[#FBEDEA] border border-[#E8C4BC] rounded-[10px] p-3 font-body text-[12.5px] text-[#A23A2E]">
              {errorMsg}
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

// ─── TrackerView ───────────────────────────────────────────────────────

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
  const patchApplication = useVantage((s) => s.patchApplication);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<AppColumn | null>(null);

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

  const selected = useMemo(
    () => apiApplications.find((a) => a.id === selectedId) ?? null,
    [apiApplications, selectedId],
  );

  // Drawer visibility is derived from `selected`, so when a row vanishes from
  // the server reload the drawer auto-closes without a follow-up render. We
  // intentionally keep `selectedId` set: if the row reappears (e.g. transient
  // refetch dropped then restored it), the drawer comes back to where the
  // user left it instead of forcing them to reselect. This sidesteps React
  // 19's `react-hooks/set-state-in-effect` warning by removing the reconcile
  // effect entirely.

  const totalReal = apiApplications.length;
  const hasInterviewing = cards.interviewing.length > 0;

  async function applyPatch(
    id: string,
    patch: { status?: string; outcome?: string; coverLetter?: string },
  ) {
    setDrawerBusy(true);
    setDrawerError(null);
    const res = await patchApplication(id, patch);
    setDrawerBusy(false);
    if (!res.ok) setDrawerError(res.error);
  }

  function onColumnDragOver(column: AppColumn, e: React.DragEvent) {
    if (draggingId === null) return;
    // Allow drop ONLY when the cursor is over a column belonging to a
    // different status. Same-column drop falls back to the default no-op.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoveredColumn(column);
  }

  function onColumnDragLeave(column: AppColumn) {
    setHoveredColumn((cur) => (cur === column ? null : cur));
  }

  async function onColumnDrop(column: AppColumn, e: React.DragEvent) {
    e.preventDefault();
    const id =
      e.dataTransfer.getData("application/x-relay-app-id") ||
      e.dataTransfer.getData("text/plain");
    const prevStatus = e.dataTransfer.getData("application/x-relay-app-status");
    setDraggingId(null);
    setHoveredColumn(null);
    if (!id) return;
    // Skip the PATCH when the row already lives in this column. Otherwise we'd
    // churn DB writes on drops back onto the source column.
    const prevColumn = prevStatus ? statusVisual(prevStatus).column : null;
    if (prevColumn === column) return;
    const nextStatus = COLUMN_DEFAULT_STATUS[column];
    await patchApplication(id, { status: nextStatus });
  }

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
        {(["applied", "interviewing", "outcome"] as AppColumn[]).map((column) => (
          <Column
            key={column}
            column={column}
            title={COLUMN_TITLES[column]}
            cards={cards[column]}
            emptyCopy={COLUMN_EMPTY_COPY[column]}
            isDropTarget={draggingId !== null}
            isHovered={hoveredColumn === column}
            onDragOver={(e) => onColumnDragOver(column, e)}
            onDragLeave={() => onColumnDragLeave(column)}
            onDrop={(e) => onColumnDrop(column, e)}
            onCardPick={setSelectedId}
            onCardDragStart={(id) => setDraggingId(id)}
            onCardDragEnd={() => {
              setDraggingId(null);
              setHoveredColumn(null);
            }}
            draggingId={draggingId}
          />
        ))}
      </div>

      {selected ? (
        <DetailDrawer
          application={selected}
          onClose={() => {
            setSelectedId(null);
            setDrawerError(null);
          }}
          onPatch={(patch) => applyPatch(selected.id, patch)}
          busy={drawerBusy}
          errorMsg={drawerError}
        />
      ) : null}
    </div>
  );
}
