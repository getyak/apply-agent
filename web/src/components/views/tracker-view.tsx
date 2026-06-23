"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useVantage, type ApiApplication, type Applied } from "@/lib/store";
import { statusVisual, type AppColumn } from "@/lib/status";
import { Sparkles, Inbox, Compass, ArrowRight, X, ShieldCheck } from "lucide-react";

type Translator = ReturnType<typeof useTranslations>;

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

const columnTitles = (t: Translator): Record<AppColumn, string> => ({
  applied: t("columns.applied"),
  interviewing: t("columns.interviewing"),
  outcome: t("columns.outcome"),
});

const columnEmptyCopy = (t: Translator): Record<AppColumn, string> => ({
  applied: t("empty.applied"),
  interviewing: t("empty.interviewing"),
  outcome: t("empty.outcome"),
});

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
function relativeFrom(iso: string | null | undefined, t: Translator): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMs = Date.now() - ts;
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return t("time.justNow");
  const m = Math.floor(s / 60);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t("time.daysAgo", { n: d });
  const w = Math.floor(d / 7);
  return t("time.weeksAgo", { n: w });
}

// Compact "what's next on this row" chip (P3.2). Distinct color tracks
// per action kind so the user can scan the column for "anything urgent
// I need to do today" without reading every card.
function NextActionBadge({ value, t }: { value: string; t: Translator }) {
  const spec = (() => {
    if (value === "interview") return { text: t("nextAction.interview"), fg: "#7A2A1F", bg: "#F4D7D2" };
    if (value === "follow_up") return { text: t("nextAction.followUp"), fg: "#8A6A12", bg: "#FBEFD0" };
    if (value === "submit") return { text: t("nextAction.ready"), fg: "#2F5722", bg: "#E2EED9" };
    if (value === "prep") return { text: t("nextAction.prep"), fg: "#5D3000", bg: "#FBEFD8" };
    if (value === "close_loop") return { text: t("nextAction.wrapUp"), fg: "#5D5046", bg: "#F4F0E8" };
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

function apiToCard(a: ApiApplication, t: Translator): TrackerCard {
  const company = a.company || t("unknownCompany");
  return {
    key: `api-${a.id}`,
    applicationId: a.id,
    mono: monoFor(company),
    company,
    role: a.role_title || t("role"),
    when: relativeFrom(a.submitted_at || a.created_at, t),
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
  t,
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
  t: Translator;
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
                aria-label={t("openCard", { role: card.role, company: card.company })}
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
                    {card.nextAction ? <NextActionBadge value={card.nextAction} t={t} /> : null}
                    <span
                      className={`font-mono text-[9px] tracking-[0.5px] uppercase px-[7px] py-[3px] rounded ${v.pillClass}`}
                    >
                      {card.isNew ? t("justSent") : v.label}
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

const statusOptions = (t: Translator): Array<{ value: string; label: string }> => [
  { value: "draft", label: t("status.draft") },
  { value: "review", label: t("status.review") },
  { value: "submitted", label: t("status.submitted") },
  { value: "interview", label: t("status.interview") },
  { value: "offer", label: t("status.offer") },
  { value: "rejected", label: t("status.rejected") },
  { value: "ghosted", label: t("status.ghosted") },
];

function DetailDrawer({
  application,
  onClose,
  onPatch,
  busy,
  errorMsg,
  t,
}: {
  application: ApiApplication;
  onClose: () => void;
  onPatch: (patch: { status?: string; outcome?: string; coverLetter?: string }) => void;
  busy: boolean;
  errorMsg: string | null;
  t: Translator;
}) {
  // A11Y_T3 (round-14): the round-14 a11y audit pointed out that this
  // drawer correctly declared role="dialog" + aria-modal="true" but
  // skipped both halves of the WAI-ARIA modal contract — Escape didn't
  // close it (only backdrop click did), and the close button wasn't
  // focused on open, so a keyboard user landed deep in the form
  // controls instead of the obvious dismiss. We also move focus to
  // the close button on mount and listen for Escape on the document
  // so a stray click anywhere stays handled.
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
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
              {t("drawer.application")}
            </div>
            <h2
              id="application-drawer-title"
              className="font-display font-bold text-[20px] leading-[1.25] text-ink m-0"
            >
              {application.role_title || t("role")}
            </h2>
            <div className="font-body text-[13px] text-ink-light mt-1">
              {application.company || t("unknownCompany")}
            </div>
            <div className="flex items-center gap-3 mt-3">
              <span
                className={`font-mono text-[9px] tracking-[0.5px] uppercase px-[7px] py-[3px] rounded ${v.pillClass}`}
              >
                {v.label}
              </span>
              <span className="font-mono text-[10px] text-ink-muted">
                {application.submitted_at
                  ? t("drawer.submittedWhen", { when: relativeFrom(application.submitted_at, t) })
                  : t("drawer.createdWhen", { when: relativeFrom(application.created_at, t) })}
              </span>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label={t("drawer.close")}
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
              {t("drawer.statusLabel")}
            </label>
            <select
              value={application.status}
              disabled={busy}
              onChange={(e) => onPatch({ status: e.target.value })}
              className="w-full bg-white border border-border-dark rounded-[8px] px-3 py-2 font-body text-[14px] text-ink focus:outline-none focus:border-brown disabled:opacity-60"
            >
              {statusOptions(t).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="font-body text-[11px] text-ink-muted mt-2 leading-[1.5]">
              {t("drawer.statusHelp")}
            </div>
          </section>

          {/* Outcome — set on the way out. */}
          <section>
            <label
              htmlFor="application-outcome"
              className="block font-mono text-[10px] tracking-[1px] uppercase text-ink-muted mb-2"
            >
              {t("drawer.outcomeLabel")}
            </label>
            <input
              id="application-outcome"
              type="text"
              defaultValue={application.outcome ?? ""}
              placeholder={t("drawer.outcomePlaceholder")}
              disabled={busy}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next === (application.outcome ?? "")) return;
                onPatch({ outcome: next });
              }}
              className="w-full bg-white border border-border-dark rounded-[8px] px-3 py-2 font-body text-[14px] text-ink focus:outline-none focus:border-brown disabled:opacity-60"
            />
            <div className="font-body text-[11px] text-ink-muted mt-2 leading-[1.5]">
              {t("drawer.outcomeHelp")}
            </div>
          </section>

          {/* Cover letter — long form. */}
          <section>
            <label
              htmlFor="application-cover"
              className="block font-mono text-[10px] tracking-[1px] uppercase text-ink-muted mb-2"
            >
              {t("drawer.coverLabel")}
            </label>
            <textarea
              id="application-cover"
              defaultValue={application.cover_letter ?? ""}
              placeholder={t("drawer.coverPlaceholder")}
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
  const t = useTranslations("tracker");
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
  // K1+K5 (round-4): a transient error banner shown when a kanban drop
  // PATCH fails. Before round-4 the drop handler awaited
  // patchApplication() but discarded the {ok,error} result — failures
  // silently rolled back via the optimistic-update path but the user
  // saw no signal, just a card mysteriously snapping back. We also
  // track an in-flight count so rapid drag-drop bursts (audit's K5
  // race) trigger a single full reload after the last patch settles,
  // re-syncing client state with whatever the server actually wrote.
  // The counter is a ref because it never affects render — only the
  // "last one out" check inside onColumnDrop's finally needs it.
  const [dropError, setDropError] = useState<string | null>(null);
  const pendingDropsRef = useRef(0);
  // N4 (round-2): dismissable info card explaining the client-side
  // delivery contract (vision.md + client-side-delivery.md §2). New users
  // land on this page with no understanding of where the "submit" step
  // actually happens — they reasonably assume Relay submits on their
  // behalf, then get confused when nothing moves. This card sets the
  // expectation up front. Persist dismissal so we don't nag returning
  // users; default to shown so the first visit always gets the brief.
  const DELIVERY_INFO_KEY = "vantage.applications.deliveryInfoSeen";
  const [showDeliveryInfo, setShowDeliveryInfo] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(DELIVERY_INFO_KEY) === "1") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowDeliveryInfo(false);
    }
  }, []);
  const dismissDeliveryInfo = () => {
    setShowDeliveryInfo(false);
    if (typeof window !== "undefined")
      window.localStorage.setItem(DELIVERY_INFO_KEY, "1");
  };

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
      buckets[statusVisual(a.status).column].push(apiToCard(a, t));
    });
    if (apiApplications.length === 0) {
      applied.forEach((a, i) => buckets.applied.push(appliedToCard(a, i)));
    }
    return buckets;
  }, [apiApplications, applied, t]);

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
    // K1+K5: surface drop failures + recover from race interleaving.
    // patchApplication already does optimistic update + rollback on
    // failure, but the snapshot it rolls back to is stale relative to
    // concurrent drops. We count in-flight patches; on the *last* one
    // settling, fire a loadApplications() to re-sync against server
    // truth. Errors get rendered in the banner below the header so the
    // user knows the card "snap-back" wasn't a UI glitch.
    pendingDropsRef.current += 1;
    setDropError(null);
    try {
      const res = await patchApplication(id, { status: nextStatus });
      if (!res.ok) {
        setDropError(
          res.error
            ? t("dropErrorWithReason", { reason: res.error })
            : t("dropError"),
        );
      }
    } finally {
      pendingDropsRef.current -= 1;
      // When the last in-flight drop settles, force a fresh fetch.
      // Cheap (~one indexed query) and worth it to keep the kanban
      // honest after the server may have rejected a status transition
      // or seen patches arrive out of the order the user dragged.
      if (pendingDropsRef.current === 0) {
        void loadApplications();
      }
    }
  }

  return (
    <div className="px-12 pt-10 pb-[60px] animate-fade-up">
      <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-[10px]">
        {t("pipeline")}
      </div>
      <div className="flex items-baseline justify-between mb-[26px] gap-4 flex-wrap">
        <h1 className="font-display font-bold text-[32px] -tracking-[0.3px] text-ink m-0">
          {t("title")}
        </h1>
        <span className="font-body text-[13px] text-ink-muted">
          {apiAppsLoading
            ? t("syncing")
            : totalReal === 0
              ? t("nothingSubmitted")
              : t("tracked", { count: totalReal })}
        </span>
      </div>

      {showDeliveryInfo && (
        <div className="mb-6 flex items-start gap-3 bg-white border border-border rounded-[13px] px-4 py-4">
          <div className="w-[34px] h-[34px] rounded-[9px] bg-cream border border-cream-border flex items-center justify-center shrink-0">
            <ShieldCheck className="w-[16px] h-[16px] text-brown" strokeWidth={1.7} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-body font-semibold text-[13.5px] text-ink">
              {t("delivery.title")}
            </div>
            <div className="font-body text-[12.5px] text-ink-light mt-[3px] leading-snug">
              {t.rich("delivery.body", {
                strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={dismissDeliveryInfo}
            title={t("delivery.dismissTitle")}
            aria-label={t("delivery.dismissLabel")}
            className="shrink-0 cursor-pointer border-none bg-transparent text-ink-muted hover:text-ink p-1 rounded-[6px]"
          >
            <X className="w-[14px] h-[14px]" strokeWidth={1.8} />
          </button>
        </div>
      )}

      {dropError && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-3 rounded-[11px] px-4 py-3"
          style={{
            background: "#FBEDEA",
            border: "1px solid #E8C4BC",
            color: "#7A2A1F",
          }}
        >
          <span className="font-body text-[13px] flex-1">{dropError}</span>
          <button
            type="button"
            onClick={() => setDropError(null)}
            title={t("dismiss")}
            aria-label={t("dismissDropError")}
            className="shrink-0 cursor-pointer border-none bg-transparent p-1 rounded-[6px]"
            style={{ color: "#7A2A1F" }}
          >
            <X className="w-[13px] h-[13px]" strokeWidth={1.8} />
          </button>
        </div>
      )}

      {hasInterviewing && (
        <div className="mb-6 flex items-center gap-3 bg-gold-bg border border-cream-border rounded-[13px] px-4 py-3">
          <Sparkles className="w-[16px] h-[16px] text-amber" strokeWidth={1.8} />
          <span className="font-body text-[13.5px] text-brown flex-1">
            {t.rich("interviewingBanner", {
              count: cards.interviewing.length,
              strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
            })}
          </span>
          <button
            type="button"
            onClick={() => openPrep(0)}
            className="cursor-pointer border-none bg-brown text-paper font-body font-semibold text-[12.5px] px-[14px] py-[7px] rounded-[8px] hover:bg-brown-light transition-colors"
          >
            {t("openPrep")}
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
              {t("firstEmptyTitle")}
            </div>
            <div className="font-body text-[12.5px] text-ink-light mt-[3px]">
              {t("firstEmptyBody")}
            </div>
          </div>
          <Link
            href="/app/today"
            className="shrink-0 inline-flex items-center gap-[6px] no-underline border-none bg-brown text-paper font-body font-semibold text-[12.5px] px-[14px] py-[7px] rounded-[8px] hover:bg-brown-light transition-colors"
          >
            {t("browseMatches")}
            <ArrowRight className="w-[13px] h-[13px]" strokeWidth={2} />
          </Link>
        </div>
      )}

      <div className="flex gap-[18px] items-start">
        {(["applied", "interviewing", "outcome"] as AppColumn[]).map((column) => (
          <Column
            key={column}
            column={column}
            title={columnTitles(t)[column]}
            cards={cards[column]}
            emptyCopy={columnEmptyCopy(t)[column]}
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
            t={t}
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
          t={t}
        />
      ) : null}
    </div>
  );
}
