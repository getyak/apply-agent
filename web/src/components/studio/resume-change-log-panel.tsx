/**
 * ResumeChangeLogPanel
 *
 * Renders the per-bullet change log a tailored résumé carries after
 * resume_agent.customize (see agents/nodes/resume_agent.py and
 * docs/ux-agent-intelligence-fix-plan.md §2.3). Each row shows:
 *
 *   - risk chip — safe / needs review / unsupported
 *   - bullet_id and one-line "explanation" from the agent
 *   - before / after diff (inline; truncated at 280 chars per side)
 *   - source_evidence link back into the base résumé
 *
 * The panel also exposes an Approve button. Per vision.md's "不编造经历"
 * red line, Approve is DISABLED whenever any row is `needs_review` or
 * `unsupported` — users must explicitly dismiss those rows (or have
 * the agent regenerate) before the tailored version can be accepted.
 *
 * Wiring is intentionally minimal here: the panel takes a typed
 * `entries` prop instead of pulling data from a store. That keeps it
 * testable in isolation and lets either the dock (when ask-stream
 * lands the artifact) or the Resume Studio (when the studio gets the
 * customize endpoint) drop the same panel in without a refactor.
 */

"use client";

import { useMemo } from "react";

export type ChangeLogRisk = "safe" | "needs_review" | "unsupported";
export type ChangeLogType =
  | "tighten"
  | "quantify_existing"
  | "reorder"
  | "infer_wording";

export interface ChangeLogEntry {
  bullet_id: string;
  change_type: string;
  before?: string | null;
  after?: string | null;
  source_evidence?: string | null;
  explanation?: string | null;
  risk?: ChangeLogRisk | string | null;
}

const CHARS = 280;

function truncate(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > CHARS ? `${s.slice(0, CHARS).trimEnd()}…` : s;
}

function riskSpec(risk: string | null | undefined) {
  if (risk === "safe") return { text: "SAFE", fg: "#2F5722", bg: "#E2EED9" };
  if (risk === "needs_review")
    return { text: "NEEDS REVIEW", fg: "#8A6A12", bg: "#FBEFD0" };
  if (risk === "unsupported")
    return { text: "UNSUPPORTED", fg: "#7A2A1F", bg: "#F4D7D2" };
  return { text: "UNKNOWN", fg: "#5D5046", bg: "#F4F0E8" };
}

function changeTypeLabel(t: string): string {
  if (t === "tighten") return "Tighten";
  if (t === "quantify_existing") return "Quantified existing";
  if (t === "reorder") return "Reorder";
  if (t === "infer_wording") return "Wording inferred";
  return t.replace(/_/g, " ");
}

interface Props {
  entries: ChangeLogEntry[];
  /**
   * Called when the user clicks Approve. The panel guarantees this
   * only fires when no `needs_review` / `unsupported` rows remain —
   * callers should still re-check server-side before persisting.
   */
  onApprove?: () => void;
  /**
   * Called when the user wants to send the tailored version back to
   * the agent for another pass. Optional — when omitted the button is
   * hidden (e.g. for a read-only audit view).
   */
  onRegenerate?: () => void;
}

export function ResumeChangeLogPanel({ entries, onApprove, onRegenerate }: Props) {
  const counts = useMemo(() => {
    let safe = 0;
    let needs = 0;
    let unsupported = 0;
    for (const e of entries) {
      if (e.risk === "safe") safe++;
      else if (e.risk === "needs_review") needs++;
      else if (e.risk === "unsupported") unsupported++;
    }
    return { safe, needs, unsupported };
  }, [entries]);

  const approveBlocked = counts.needs > 0 || counts.unsupported > 0;

  if (entries.length === 0) {
    return (
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #EDE8DF",
          borderRadius: 12,
          padding: 16,
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 13,
          color: "#5D5046",
        }}
      >
        No change log on this version — either the agent didn&apos;t emit one
        or this is the original master. There&apos;s nothing to review.
      </div>
    );
  }

  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid #EDE8DF",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {/* Header band — summary counts + actions. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          borderBottom: "1px solid #EDE8DF",
          background: "#FBF8F3",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 10,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "#A39F99",
            flex: "0 0 auto",
          }}
        >
          CHANGE LOG · {entries.length}{" "}
          {entries.length === 1 ? "EDIT" : "EDITS"}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <CountChip n={counts.safe} label="safe" risk="safe" />
          <CountChip n={counts.needs} label="needs review" risk="needs_review" />
          <CountChip n={counts.unsupported} label="unsupported" risk="unsupported" />
        </div>
        <div style={{ flex: 1 }} />
        {onRegenerate ? (
          <button
            type="button"
            onClick={onRegenerate}
            style={{
              cursor: "pointer",
              background: "#FFFFFF",
              border: "1px solid #E8DCCA",
              color: "#2B2822",
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 500,
              fontSize: 12.5,
              padding: "7px 12px",
              borderRadius: 8,
            }}
          >
            Regenerate
          </button>
        ) : null}
        {onApprove ? (
          <button
            type="button"
            disabled={approveBlocked}
            onClick={() => {
              if (approveBlocked) return;
              onApprove();
            }}
            title={
              approveBlocked
                ? "Clear the needs-review / unsupported rows first"
                : "Accept this tailored version"
            }
            style={{
              cursor: approveBlocked ? "not-allowed" : "pointer",
              background: approveBlocked ? "#E8DCCA" : "#5D3000",
              color: approveBlocked ? "#A39F99" : "#FAF8F6",
              border: "none",
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 13,
              padding: "8px 14px",
              borderRadius: 8,
              opacity: approveBlocked ? 0.7 : 1,
            }}
          >
            Approve
          </button>
        ) : null}
      </div>

      {/* Row stack — one bullet per row. We use a real <ol> so screen
          readers narrate "1 of N" without us hand-rolling aria-pos. */}
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          maxHeight: 480,
          overflowY: "auto",
        }}
      >
        {entries.map((e, i) => (
          <li
            key={`${e.bullet_id}-${i}`}
            style={{
              padding: "14px 16px",
              borderTop: i === 0 ? "none" : "1px solid #F4F0E8",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <RiskChip risk={e.risk ?? null} />
              <span
                style={{
                  fontFamily: "JetBrains Mono, ui-monospace, monospace",
                  fontSize: 10.5,
                  color: "#5D5046",
                }}
              >
                {e.bullet_id}
              </span>
              <span
                style={{
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 11.5,
                  color: "#A39F99",
                }}
              >
                · {changeTypeLabel(e.change_type)}
              </span>
            </div>
            {e.explanation ? (
              <div
                style={{
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 12.5,
                  color: "#5D5046",
                  lineHeight: 1.45,
                }}
              >
                {e.explanation}
              </div>
            ) : null}
            <DiffPair before={e.before} after={e.after} />
            {e.source_evidence ? (
              <div
                style={{
                  fontFamily: "JetBrains Mono, ui-monospace, monospace",
                  fontSize: 10,
                  letterSpacing: 0.4,
                  color: "#A39F99",
                }}
              >
                evidence: {e.source_evidence}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RiskChip({ risk }: { risk: string | null }) {
  const spec = riskSpec(risk);
  return (
    <span
      style={{
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 9.5,
        letterSpacing: 0.5,
        padding: "2px 7px",
        borderRadius: 999,
        color: spec.fg,
        background: spec.bg,
      }}
    >
      {spec.text}
    </span>
  );
}

function CountChip({
  n,
  label,
  risk,
}: {
  n: number;
  label: string;
  risk: ChangeLogRisk;
}) {
  const spec = riskSpec(risk);
  // Zero-count chips render dimmed so the user knows that bucket
  // exists but is empty — clearer than hiding them outright.
  return (
    <span
      style={{
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 10,
        letterSpacing: 0.4,
        padding: "3px 8px",
        borderRadius: 6,
        color: n === 0 ? "#A39F99" : spec.fg,
        background: n === 0 ? "#F4F0E8" : spec.bg,
      }}
    >
      {n} {label.toUpperCase()}
    </span>
  );
}

function DiffPair({
  before,
  after,
}: {
  before: string | null | undefined;
  after: string | null | undefined;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 8,
      }}
    >
      <div
        style={{
          background: "#F4F0E8",
          border: "1px solid #EDE8DF",
          borderRadius: 8,
          padding: "8px 10px",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 12.5,
          lineHeight: 1.5,
          color: "#5D5046",
          minHeight: 30,
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 9,
            letterSpacing: 0.5,
            color: "#A39F99",
            marginBottom: 4,
          }}
        >
          BEFORE
        </div>
        {truncate(before) || (
          <span style={{ color: "#A39F99" }}>
            <em>(no prior bullet)</em>
          </span>
        )}
      </div>
      <div
        style={{
          background: "#FFFBF4",
          border: "1px solid #E8DCCA",
          borderRadius: 8,
          padding: "8px 10px",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 12.5,
          lineHeight: 1.5,
          color: "#2B2822",
          minHeight: 30,
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 9,
            letterSpacing: 0.5,
            color: "#A39F99",
            marginBottom: 4,
          }}
        >
          AFTER
        </div>
        {truncate(after) || (
          <span style={{ color: "#A39F99" }}>
            <em>(empty)</em>
          </span>
        )}
      </div>
    </div>
  );
}
