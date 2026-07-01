"use client";

// Résumé dual-track view — the triple-rail surface for migration 017's
// `track` axis (original / optimized / tailored) plus the accept/reject
// suggestion stack from `resume_suggestions`.
//
// Design: docs/design/resume-original-vs-optimized-vibe-design.md §4–§6.
//   · Original track  = immutable uploads (prevent_original_mutation trigger).
//   · Optimized track = AI siblings derived_from an original (no JD).
//   · Tailored track  = per-JD branches derived_from an original/optimized.
//   · Suggestion stack = proposed → accepted/rejected; accept folds the change
//     into a new optimized version (the agent owns that write).
//
// This component is deliberately *pure presentational* — no data fetching, no
// effects. `resume-view.tsx` (the container) owns the API calls and passes the
// three arrays + suggestions + callbacks down. Keeping it prop-driven makes it
// unit-testable via react-dom/server (the web package avoids a DOM test lib —
// see web/src/lib/use-resume-edit.test.ts for that convention) and keeps the
// accessibility contract (aria roles, keyboard nav) in one auditable place.

import { useTranslations } from "next-intl";

export type ResumeTrack = "original" | "optimized" | "tailored";

export interface DualTrackVersion {
  id: string;
  version: number;
  track: ResumeTrack;
  derivedFrom: string | null;
  createdAt: string;
}

export interface DualTrackSuggestion {
  id: string;
  bullet_stable_id: string | null;
  section: string | null;
  change_type: string;
  before_text: string;
  after_text: string;
  rationale: string | null;
  risk_level: "safe" | "needs_review" | "unsupported";
  status: string;
  proposed_by: string;
}

export interface ResumeDualTrackProps {
  originals: DualTrackVersion[];
  optimized: DualTrackVersion[];
  tailored: DualTrackVersion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  suggestions: DualTrackSuggestion[];
  onDecide: (id: string, decision: "accept" | "reject") => void;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

const TRACK_META: Record<
  ResumeTrack,
  { labelKey: string; captionKey: string; colAria: string }
> = {
  original: {
    labelKey: "rail.original.label",
    captionKey: "rail.original.caption",
    colAria: "dualTrack.originalColAria",
  },
  optimized: {
    labelKey: "rail.optimized.label",
    captionKey: "rail.optimized.caption",
    colAria: "dualTrack.optimizedColAria",
  },
  tailored: {
    labelKey: "rail.tailored.label",
    captionKey: "rail.tailored.caption",
    colAria: "dualTrack.tailoredColAria",
  },
};

export function ResumeDualTrack({
  originals,
  optimized,
  tailored,
  selectedId,
  onSelect,
  suggestions,
  onDecide,
}: ResumeDualTrackProps) {
  const t = useTranslations("resume");
  return (
    <section
      aria-label={t("dualTrack.regionAria")}
      data-testid="resume-dual-track"
      style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
    >
      <div
        role="list"
        aria-label={t("dualTrack.columnsAria")}
        style={{ display: "flex", gap: 16, flex: 1, minHeight: 0, padding: 18 }}
      >
        <TrackColumn
          t={t}
          track="original"
          rows={originals}
          selectedId={selectedId}
          onSelect={onSelect}
          immutable
        />
        <TrackColumn
          t={t}
          track="optimized"
          rows={optimized}
          selectedId={selectedId}
          onSelect={onSelect}
        />
        <TrackColumn
          t={t}
          track="tailored"
          rows={tailored}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </div>
      <SuggestionStack t={t} suggestions={suggestions} onDecide={onDecide} />
    </section>
  );
}

// Exported for unit tests. These sub-components take `t` as a prop (no
// useTranslations hook inside), so a test can invoke them directly and fire
// their onClick closures without a DOM — verifying the id→handler binding.
export function TrackColumn({
  t,
  track,
  rows,
  selectedId,
  onSelect,
  immutable = false,
}: {
  t: Translate;
  track: ResumeTrack;
  rows: DualTrackVersion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  immutable?: boolean;
}) {
  const meta = TRACK_META[track];
  return (
    <div
      role="listitem"
      aria-label={t(meta.colAria)}
      data-track={track}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid #EDE8DF",
        borderRadius: 12,
        background: "#FBF8F3",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 14px",
          borderBottom: "1px solid #EDE8DF",
        }}
      >
        <span
          style={{
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: 10,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: "#6B6560",
          }}
        >
          {t(meta.labelKey)}
        </span>
        {immutable ? (
          <span
            data-testid="immutable-badge"
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 9,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "#4C7A3F",
              background: "#EAF3E6",
              border: "1px solid #CFE3C6",
              borderRadius: 999,
              padding: "1px 7px",
            }}
          >
            {t("dualTrack.immutableBadge")}
          </span>
        ) : (
          <span className="ds-mono-10">{rows.length}</span>
        )}
      </div>
      <div className="ds-caption" style={{ padding: "8px 14px", color: "#A39F99" }}>
        {t(meta.captionKey)}
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: "0 8px 12px",
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
        }}
      >
        {rows.length === 0 ? (
          <li
            className="ds-caption"
            style={{ padding: "6px 8px", color: "#C2BBB0", fontStyle: "italic" }}
          >
            {t("dualTrack.emptyColumn")}
          </li>
        ) : (
          rows.map((v) => {
            const isCurrent = v.id === selectedId;
            return (
              <li key={v.id} style={{ margin: "4px 0" }}>
                <button
                  type="button"
                  onClick={() => onSelect(v.id)}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={t("dualTrack.selectAria", {
                    track: t(meta.labelKey),
                    v: v.version,
                  })}
                  data-testid={`track-row-${track}-${v.version}`}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    cursor: "pointer",
                    border: `1px solid ${isCurrent ? "#5D3000" : "transparent"}`,
                    background: isCurrent ? "#F5EDE3" : "transparent",
                    borderRadius: 9,
                    padding: "9px 11px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "JetBrains Mono",
                      fontWeight: 500,
                      fontSize: 12,
                      color: "#2B2822",
                    }}
                  >
                    v{v.version}
                  </span>
                  <span className="ds-body-sm" style={{ fontSize: 12, color: "#6B6560" }}>
                    {track === "original"
                      ? t("track.originalSummary")
                      : track === "optimized"
                        ? t("track.optimizedSummary")
                        : t("track.tailoredSummary")}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

export function SuggestionStack({
  t,
  suggestions,
  onDecide,
}: {
  t: Translate;
  suggestions: DualTrackSuggestion[];
  onDecide: (id: string, decision: "accept" | "reject") => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      role="region"
      aria-label={t("dualTrack.suggestionsAria")}
      data-testid="suggestion-stack"
      style={{
        flexShrink: 0,
        maxHeight: "40%",
        overflowY: "auto",
        borderTop: "1px solid #EDE8DF",
        background: "#FFFBF4",
        padding: "14px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span className="ds-mono-10" style={{ color: "#5D3000" }}>
          {t("suggestions.count", { count: suggestions.length })}
        </span>
        <span className="ds-caption" style={{ color: "#A39F99" }}>
          {t("suggestions.subtitle")}
        </span>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {suggestions.map((s) => (
          <li key={s.id} className="ds-card" style={{ padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
              <span className="ds-mono-10" style={{ color: "#6B6560" }}>{s.change_type}</span>
              {s.risk_level === "needs_review" ? (
                <span
                  data-testid={`risk-${s.id}`}
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: 8,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: "#A66A00",
                    background: "#FBEFD8",
                    padding: "2px 6px",
                    borderRadius: 4,
                  }}
                >
                  {t("suggestions.needsReview")}
                </span>
              ) : null}
            </div>
            <div
              className="ds-body-sm"
              aria-label={t("dualTrack.beforeLabel")}
              style={{ fontSize: 12.5, color: "#A39F99", textDecoration: "line-through", marginBottom: 4 }}
            >
              {s.before_text}
            </div>
            <div
              className="ds-body-sm"
              aria-label={t("dualTrack.afterLabel")}
              style={{ fontSize: 13, color: "#2B2822", marginBottom: 6 }}
            >
              {s.after_text}
            </div>
            {s.rationale ? (
              <div className="ds-caption" style={{ color: "#6B6560", marginBottom: 8 }}>{s.rationale}</div>
            ) : null}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => onDecide(s.id, "accept")}
                aria-label={t("dualTrack.acceptAria", { change: s.change_type })}
                data-testid={`accept-${s.id}`}
                style={{
                  cursor: "pointer",
                  border: "1px solid #4C7A3F",
                  background: "#4C7A3F",
                  color: "#FFFFFF",
                  fontFamily: "Inter",
                  fontWeight: 600,
                  fontSize: 12,
                  padding: "5px 12px",
                  borderRadius: 8,
                }}
              >
                {t("suggestions.accept")}
              </button>
              <button
                type="button"
                onClick={() => onDecide(s.id, "reject")}
                aria-label={t("dualTrack.rejectAria", { change: s.change_type })}
                data-testid={`reject-${s.id}`}
                style={{
                  cursor: "pointer",
                  border: "1px solid #D6CEC0",
                  background: "#FFFFFF",
                  color: "#6B6560",
                  fontFamily: "Inter",
                  fontWeight: 600,
                  fontSize: 12,
                  padding: "5px 12px",
                  borderRadius: 8,
                }}
              >
                {t("suggestions.reject")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
