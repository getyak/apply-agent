"use client";

// The Ask Vantage dock — persistent across all workspace routes.
// Modes from Vantage.dc.html (lines 818–976):
//   closed   floating launcher pill at bottom-right
//   docked   right-side panel, user-resizable 280–560px
//   full     264px Recent rail + chat surface, overlays whole shell
//
// Mock-live sets hintedCollapse → we auto-collapse to launcher per
// docs/architecture/vantage-ui-mapping.md §3.6.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AUTO_EXPAND_AFTER_MS,
  formatElapsed,
  useElapsedMs,
} from "@/lib/use-elapsed";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/react/shallow";
import {
  useDock,
  type AgentEvent,
  type DockAttachment,
  type DockMessage,
  type ArtifactAction,
  type ArtifactSuggestion,
} from "@/lib/ask-vantage-store";
import { sendAsk } from "@/lib/ask-stream";
import { useVantage } from "@/lib/store";
import { files as filesApi, resumes as resumesApi } from "@/lib/api";
import { greetingFor } from "@/lib/dates";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { ReasoningSummary } from "@/components/chat/reasoning-summary";
import { StreamingCursor } from "@/components/chat/streaming-cursor";
import { HitlCard } from "@/components/ask-vantage/dock-hitl-card";

// A single chip carries two strings: `display` is the short English line on
// the card; `prompt` is the verbose instruction we actually send to the
// coordinator. Splitting them keeps the cards scannable without dumbing
// down the prompt the LLM gets — the vibe panel's long prompts (e.g.
// "Analyze this résumé and tell me the three weakest spots — be specific
// about which bullet or section, and what to change.") survive verbatim
// into the dock conversation.
interface SuggestionChip {
  // i18n key (under the "dock" namespace) for the short card label the user
  // reads. The verbose `prompt` below stays English on purpose — it's the
  // instruction sent to the coordinator/LLM and is grepped by prompt-eval
  // for the no-fabrication red line, so it must not vary by locale.
  displayKey: string;
  prompt: string;
}

interface SuggestionGroup {
  // `id` is stable so React can key without using the (possibly duplicate)
  // label as the key.
  id: "this_resume" | "explore";
  // i18n key for the group heading.
  labelKey: string;
  // i18n key for the one-liner shown next to the group label. For scoped
  // groups this is where we keep the old Vibe Chat's "scoped to this
  // résumé" contract so users still know what the group acts on.
  scopeHintKey?: string;
}

// Explore group — global tracks you'd ask Vantage from any page. Same set
// the dock has always shown, minus the résumé-specific "Sharpen my résumé
// for Stripe" since that now belongs inside the This-résumé group on the
// Resume Studio route.
const CHIPS_EXPLORE_DEFAULT: SuggestionChip[] = [
  { displayKey: "chips.explore.findRolesToday", prompt: "Find roles I should look at today" },
  { displayKey: "chips.explore.sharpenForStripe", prompt: "Sharpen my résumé for Stripe" },
  { displayKey: "chips.explore.practiseStripeScreen", prompt: "Practise the Stripe recruiter screen" },
  { displayKey: "chips.explore.marketThisWeek", prompt: "What changed in the market this week?" },
  { displayKey: "chips.explore.coverLetterLinear", prompt: "Build me a cover letter for Linear" },
];

const CHIPS_EXPLORE_RESUME_STUDIO: SuggestionChip[] = [
  { displayKey: "chips.explore.findRolesToday", prompt: "Find roles I should look at today" },
  { displayKey: "chips.explore.practiseStripeScreen", prompt: "Practise the Stripe recruiter screen" },
  { displayKey: "chips.explore.marketThisWeek", prompt: "What changed in the market this week?" },
  { displayKey: "chips.explore.coverLetterLinear", prompt: "Build me a cover letter for Linear" },
];

// "This résumé" group — migrated from the old VibeChatPanel. Each chip's
// `prompt` is the original verbose instruction so the resume_agent sees
// the same input it always has; `display` is the action-style English
// short line the user sees on the card.
// H1 (round-1): every chip in this group must repeat the no-fabrication
// red line in its prompt. Until round 1 only "Tailor this résumé to a JD"
// carried the constraint, leaving the other three free to invent skills,
// re-interpret bullet metrics, or surface non-existent companies — direct
// violations of vision.md §"诚实是底线". The phrasing is deliberately
// uniform so prompt-eval can grep for the same red-line string across the
// whole group instead of three different rewordings.
const CHIPS_THIS_RESUME: SuggestionChip[] = [
  {
    displayKey: "chips.thisResume.weakestSpots",
    prompt:
      "Analyze this résumé and tell me the three weakest spots — be specific about which bullet or section, and what to change. Critique only what is actually written; do not invent skills, employers, dates, or metrics that aren't in the résumé.",
  },
  {
    displayKey: "chips.thisResume.tailorToJd",
    prompt:
      "I want to tailor this résumé for a specific role. Ask me to paste the JD, then customize the bullets to match — without inventing experience I don't have.",
  },
  {
    displayKey: "chips.thisResume.careerMoves",
    prompt:
      "Read my résumé's trajectory and tell me what the next one or two career moves should look like, plus which skills I'd need to close to get there. Base every suggestion on roles and skills that are actually in the résumé — do not invent companies I haven't worked at or skills I haven't demonstrated.",
  },
  {
    displayKey: "chips.thisResume.surfaceRoles",
    prompt:
      "Based on this résumé, suggest five roles that would be a strong match right now — and explain in one line why each fits. Only cite skills, titles, and experiences that appear in the résumé; do not invent qualifications to make a role look like a better fit.",
  },
];

// Resolve chip groups for the current route. The Resume Studio surface
// surfaces *two* groups: This résumé (scoped) + Explore (global). All
// other surfaces show only Explore — keeps the new structure invisible
// where it doesn't apply.
function chipGroupsForPath(
  pathname: string | null,
): { meta: SuggestionGroup; chips: SuggestionChip[] }[] {
  if (pathname?.startsWith("/app/studio/resume")) {
    return [
      {
        meta: {
          id: "this_resume",
          labelKey: "groups.thisResume",
          scopeHintKey: "groups.thisResumeScope",
        },
        chips: CHIPS_THIS_RESUME,
      },
      {
        meta: { id: "explore", labelKey: "groups.explore" },
        chips: CHIPS_EXPLORE_RESUME_STUDIO,
      },
    ];
  }
  return [
    {
      meta: { id: "explore", labelKey: "groups.explore" },
      chips: CHIPS_EXPLORE_DEFAULT,
    },
  ];
}

// Agent teams surfaced via "@" mentions — each is a LangGraph node name on
// the coordinator side (see docs/architecture/agent-architecture.md §2).
// `label` keeps the agent's English proper name (Scout / Résumé / …) per the
// i18n brief; `hintKey` points at a localised one-line description.
const AGENT_TEAMS: { slug: string; label: string; hintKey: string }[] = [
  { slug: "@scout", label: "Scout", hintKey: "agentTeams.scout" },
  { slug: "@resume", label: "Résumé", hintKey: "agentTeams.resume" },
  { slug: "@interview", label: "Interview", hintKey: "agentTeams.interview" },
  { slug: "@apply", label: "Application", hintKey: "agentTeams.apply" },
  { slug: "@trend", label: "Trend", hintKey: "agentTeams.trend" },
];

// Web Speech API has prefixed / unprefixed builds and a non-standard event
// shape. We only ever touch a tiny subset, so this loose declaration keeps
// us off `any` without pulling a whole lib.dom diff.
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionLike)
  | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function VantageMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#FAF8F6"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 2.5l1.7 4.6 4.9.2-3.8 3 1.3 4.7-4-2.8-4 2.8 1.3-4.7-3.8-3 4.9-.2z" />
    </svg>
  );
}

function Spinner() {
  return (
    <div
      className="animate-spin"
      style={{
        width: 15,
        height: 15,
        borderRadius: 999,
        border: "2px solid #F0E4D2",
        borderTopColor: "#A66A00",
        flexShrink: 0,
      }}
    />
  );
}

function CheckBadge() {
  return (
    <div
      style={{
        width: 20,
        height: 20,
        borderRadius: 6,
        background: "#F5EDE3",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#5D3000" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h7l-1 8 10-12h-7z" />
      </svg>
    </div>
  );
}

function AgentCardRow({ id }: { id: string }) {
  const t = useTranslations("dock");
  const ev = useDock((s) => s.agentEvents[id]);
  // Default collapsed in both states. The header alone (spinner + agent
  // label + status chip) already tells the user "this agent is working /
  // done"; the agent / started-at / status metadata inside the body is
  // debug-grade and is only useful when they actively dig in. Earlier
  // versions force-expanded while running, which produced a wall of
  // mono-spaced metadata under every turn.
  const [open, setOpen] = useState<boolean>(false);
  // Step 2: hooks must be called before any conditional return so React's
  // hook-order invariant holds. We resolve the running flag with a safe
  // default — when `ev` is briefly undefined (transient store eviction)
  // the hook is paused and produces 0, which we never render anyway.
  const running = ev?.state === "running";
  const elapsedMs = useElapsedMs({
    startedAt: ev?.ts ?? 0,
    running,
  });
  // Auto-expand once we cross the "did this hang?" threshold. Don't auto-
  // collapse afterwards — once the user sees the metadata they probably
  // want it to stay visible. Manual toggle still wins.
  useEffect(() => {
    if (running && elapsedMs >= AUTO_EXPAND_AFTER_MS) {
      setOpen((cur) => cur || true);
    }
  }, [running, elapsedMs]);
  if (!ev) return null;
  const statusColor =
    ev.state === "done"
      ? "#4C7A3F"
      : ev.state === "failed"
        ? "#A23A2E"
        : "#A66A00";
  const startedAt = new Date(ev.ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // Status string overload:
  // - running → "Thinking · 1.4s" (becomes "Running · 1.4s" once a tool
  //   spinner-spawn fires; the dock_agent's narrator chip carries the
  //   *why*, this row carries the *for how long*).
  // - done/failed → upstream statusText (preserved).
  const liveStatusText = running
    ? t("agentCard.thinkingElapsed", { elapsed: formatElapsed(elapsedMs) })
    : ev.statusText;
  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid #E8DCCA",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? t("agentCard.collapse") : t("agentCard.expand")}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            width: 12,
            color: "#A39F99",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform .12s ease-out",
          }}
        >
          ▶
        </span>
        {ev.state === "running" ? <Spinner /> : <CheckBadge />}
        <span className="ds-mono-10" style={{ color: "#5D3000" }}>
          {ev.label}
        </span>
        <span
          className="ds-mono-9"
          data-testid="agent-status-text"
          style={{ marginLeft: "auto", color: statusColor }}
        >
          {liveStatusText}
        </span>
      </button>
      {open ? (
        <div
          style={{
            borderTop: "1px solid #F0E8DA",
            padding: "8px 14px 12px 38px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            background: "#FBF8F3",
          }}
        >
          <div className="ds-mono-9" style={{ color: "#A39F99" }}>
            {t("meta.agent")} · <span style={{ color: "#5D3000" }}>{ev.agent}</span>
          </div>
          <div className="ds-mono-9" style={{ color: "#A39F99" }}>
            {t("meta.started")} · <span style={{ color: "#5D3000" }}>{startedAt}</span>
          </div>
          <div className="ds-mono-9" style={{ color: "#A39F99" }}>
            {t("meta.status")} · <span style={{ color: statusColor }}>{ev.state}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Step 3 — ToolTraceRow. Compact "console" line for every execution tool
// the dock_agent ran. Default collapsed: name · summary · duration on the
// right. Expand to see (tool / agent → action / status) metadata. We don't
// inline the full tool result here because that already arrives as either
// an `artifact` card or a `result` card right after this row.
function ToolTraceRow({ m }: { m: DockMessage }) {
  const t = useTranslations("dock");
  const [open, setOpen] = useState<boolean>(false);
  const tool = m.toolName || "";
  const agent = m.toolAgent || "coordinator";
  const action = m.toolAction || "";
  const status = m.toolStatus || "ok";
  const summary =
    m.toolSummary || (status === "error" ? t("tool.failed") : t("tool.ok"));
  const startedAt = m.toolStartedAt || 0;
  // Pure display only — the tool has *already finished* by the time this
  // message exists in the store (dock_agent only emits tool_trace on
  // tool_end / tool_error). So `running=false` and the chip shows the
  // wall-clock the row was inserted, frozen. We still wire the hook so
  // the format helper / threshold const are in one consistent path.
  const elapsedMs = useElapsedMs({ startedAt, running: false });
  const ok = status === "ok";
  const dotColor = ok ? "#4C7A3F" : "#A23A2E";
  return (
    <div
      data-msg-id={m.id}
      data-testid="dock-tool-trace"
      className="animate-pop"
      style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
    >
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: "#FFFFFF",
          border: "1px solid #EDE8DF",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? t("tool.collapse") : t("tool.expand")}
          data-testid="dock-tool-trace-toggle"
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              width: 12,
              color: "#A39F99",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform .12s ease-out",
            }}
          >
            ▶
          </span>
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 7,
              height: 7,
              borderRadius: 999,
              background: dotColor,
              flexShrink: 0,
            }}
          />
          <span
            className="ds-mono-10"
            style={{ color: "#5D3000", flexShrink: 0 }}
          >
            {tool}
          </span>
          <span
            style={{
              color: "#7C7367",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12,
              minWidth: 0,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </span>
          <span
            className="ds-mono-9"
            data-testid="dock-tool-trace-duration"
            style={{ color: "#A39F99", marginLeft: "auto", flexShrink: 0 }}
          >
            {formatElapsed(elapsedMs)}
          </span>
        </button>
        {open ? (
          <div
            style={{
              borderTop: "1px solid #F0E8DA",
              padding: "10px 14px 12px 38px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              background: "#FBF8F3",
            }}
          >
            <div className="ds-mono-9" style={{ color: "#A39F99" }}>
              {t("meta.tool")} · <span style={{ color: "#5D3000" }}>{tool}</span>
            </div>
            <div className="ds-mono-9" style={{ color: "#A39F99" }}>
              {t("meta.agent")} · <span style={{ color: "#5D3000" }}>{agent}</span>
              {action ? (
                <>
                  {" → "}
                  <span style={{ color: "#5D3000" }}>{action}</span>
                </>
              ) : null}
            </div>
            <div className="ds-mono-9" style={{ color: "#A39F99" }}>
              {t("meta.status")} · <span style={{ color: dotColor }}>{status}</span>
            </div>
            {/* Inline-detail upgrade: surface the raw tool input + output
                so a user (or developer) can see exactly what the agent
                said and what came back. The Output is server-capped to
                8 KiB; JsonBlock additionally clamps render to ~200 lines.
                When either is undefined the section silently disappears
                (older backends won't ship the fields). */}
            {m.toolArgs !== undefined ? (
              <JsonBlock label={t("tool.input")} value={m.toolArgs} />
            ) : null}
            {m.toolResult !== undefined ? (
              <JsonBlock label={t("tool.output")} value={m.toolResult} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// JsonBlock — small pretty-printed JSON viewer used inside ToolTraceRow's
// expand panel. Caps rendering to the first ~200 lines (matches the
// 8 KiB server-side truncation in dock_agent._cap_for_wire) so a runaway
// tool result can't blow up the dock's layout. A "show more" toggle
// lets the curious unfold the rest in-place; nothing is hidden from
// keyboard / copy.
const JSONBLOCK_PREVIEW_LINES = 200;
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const t = useTranslations("dock");
  const [expanded, setExpanded] = useState(false);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      // Circular ref or other JSON crash — fall back to a plain string
      // so we at least show *something* instead of crashing the row.
      return String(value);
    }
  }, [value]);
  const lines = pretty.split("\n");
  const overflowing = lines.length > JSONBLOCK_PREVIEW_LINES;
  const visible =
    overflowing && !expanded
      ? lines.slice(0, JSONBLOCK_PREVIEW_LINES).join("\n")
      : pretty;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="ds-mono-9" style={{ color: "#A39F99" }}>
        {label.toLowerCase()}
      </div>
      <pre
        style={{
          margin: 0,
          background: "#FFFFFF",
          border: "1px solid #F0E8DA",
          borderRadius: 6,
          padding: "8px 10px",
          maxHeight: 220,
          overflowY: "auto",
          overflowX: "auto",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          fontSize: 11.5,
          lineHeight: 1.5,
          color: "#2B2822",
          whiteSpace: "pre",
          wordBreak: "normal",
        }}
      >
        {visible}
        {overflowing && !expanded
          ? `\n…${t("tool.moreLines", { count: lines.length - JSONBLOCK_PREVIEW_LINES })}`
          : ""}
      </pre>
      {overflowing ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ds-mono-9"
          style={{
            all: "unset",
            cursor: "pointer",
            color: "#5D3000",
            alignSelf: "flex-start",
            padding: "2px 0",
          }}
        >
          {expanded ? t("tool.showLess") : t("tool.showAll")}
        </button>
      ) : null}
    </div>
  );
}

// Step 5 — PartialArtifactRow. Live, in-progress preview of an artifact
// still being generated. Rendered as a card with a progress bar (when
// progress is reported), title/sub lines, and a small payload preview.
// The eventual `artifact` frame supersedes the partial — when that
// happens, the dock keeps both rows visible (the user mental model is
// "preview → final"); we don't auto-remove the partial.
function PartialArtifactRow({ m }: { m: DockMessage }) {
  const t = useTranslations("dock");
  const title = m.partialTitle || t("partial.drafting");
  const sub = m.partialSub || "";
  const progress =
    typeof m.partialProgress === "number"
      ? Math.max(0, Math.min(1, m.partialProgress))
      : null;
  const previewItems = renderPartialPayloadPreview(m.partialPayload);
  return (
    <div
      data-msg-id={m.id}
      data-testid="dock-partial-artifact"
      className="animate-pop"
      style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
    >
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: "#FBF8F3",
          border: "1px dashed #C9A06A",
          borderRadius: 12,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden
            data-testid="dock-partial-artifact-pulse"
            style={{
              display: "inline-block",
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "#C9A06A",
            }}
            className="animate-pulse"
          />
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 13.5,
              color: "#5D3000",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
          {progress !== null ? (
            <span
              className="ds-mono-9"
              data-testid="dock-partial-artifact-progress"
              style={{ color: "#A66A00" }}
            >
              {Math.round(progress * 100)}%
            </span>
          ) : null}
        </div>
        {progress !== null ? (
          <div
            aria-hidden
            style={{
              height: 4,
              background: "#F0E1C8",
              borderRadius: 999,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.round(progress * 100)}%`,
                background: "#C9A06A",
                transition: "width .2s ease-out",
              }}
            />
          </div>
        ) : null}
        {sub ? (
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12,
              color: "#7C7367",
            }}
          >
            {sub}
          </div>
        ) : null}
        {previewItems.length > 0 ? (
          <ul
            data-testid="dock-partial-artifact-items"
            style={{
              margin: 0,
              padding: "0 0 0 18px",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12.5,
              color: "#3D3933",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {previewItems.map((item, idx) => (
              <li key={idx} style={{ lineHeight: 1.45 }}>
                {item}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

// Pure helper: derive a short string list from a partial payload. We
// support the two shapes tools are likely to emit:
//   - {items: [...]} → preview first 5
//   - {text: "..."} → preview as a single line
// Anything else returns an empty list (we still render the card chrome).
function renderPartialPayloadPreview(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.items)) {
    return obj.items
      .slice(0, 5)
      .map((it) => (typeof it === "string" ? it : JSON.stringify(it)))
      .map((s) => (s.length > 200 ? s.slice(0, 200) + "…" : s));
  }
  if (typeof obj.text === "string") {
    const t = obj.text as string;
    return [t.length > 280 ? t.slice(0, 280) + "…" : t];
  }
  return [];
}

// AgentsGroupRow — reads the live AgentEvent records out of the dock
// store for a single turn's ids, hands them to ReasoningSummary for the
// outer collapse, and renders the existing AgentCardRow stack inside.
// Kept here (instead of in chat/reasoning-summary.tsx) because it needs
// to know the dock store layout. Future surfaces with their own store
// can ship their own wrapper around the same ReasoningSummary view.
function AgentsGroupRow({ ids }: { ids: string[] }) {
  // Selector returns a fresh array each call — wrap with useShallow so
  // zustand v5 + React 19's useSyncExternalStore treats element-equal
  // arrays as the same snapshot. Without this we trip the
  // "getSnapshot should be cached" infinite-loop guard.
  const events = useDock(
    useShallow((s): AgentEvent[] => {
      const out: AgentEvent[] = [];
      for (const id of ids) {
        const ev = s.agentEvents[id];
        if (ev) out.push(ev);
      }
      return out;
    }),
  );
  if (events.length === 0) return null;

  // One-step turn: the AgentCardRow already collapses by itself and
  // shows the same label / status. Wrapping it in a second outer
  // "Thinking · 2.3s · 1 step" header just duplicates information and
  // doubles the chrome (we saw two chevrons stacked vertically). Skip
  // the outer wrapper in that case and let the single card speak.
  const inner = ids.map((id) => <AgentCardRow key={id} id={id} />);
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
      <div style={{ width: 28, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {events.length === 1 ? (
          inner
        ) : (
          <ReasoningSummary events={events}>{inner}</ReasoningSummary>
        )}
      </div>
    </div>
  );
}

function MessageRow({
  m,
  isLastAssistant,
  streaming,
}: {
  m: DockMessage;
  // Whether this row is the most recent assistant bubble AND a stream is
  // currently in flight — drives the trailing <StreamingCursor/>.
  isLastAssistant: boolean;
  streaming: boolean;
}) {
  const t = useTranslations("dock");
  if (m.kind === "tool_trace") {
    return <ToolTraceRow m={m} />;
  }

  if (m.kind === "partial_artifact") {
    return <PartialArtifactRow m={m} />;
  }

  if (m.kind === "narrator") {
    // Step 1 — italic "thought-aloud" chip. Sits between the agents row /
    // task graph card and the next tool, mirroring Manus's pre-tool
    // narration. No avatar, no bubble — visually quiet so the dock log
    // still feels like a conversation.
    const text = (m.text || "").trim();
    if (!text) return null;
    return (
      <div
        data-msg-id={m.id}
        data-testid="dock-narrator"
        className="animate-pop"
        style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
      >
        <div style={{ width: 28, flexShrink: 0 }} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: "#7C7367",
            fontFamily: "Inter, system-ui, sans-serif",
            fontStyle: "italic",
            fontSize: 12.5,
            lineHeight: 1.45,
            padding: "0 2px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          {/* small leading dot keeps the chip readable on long lines */}
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "#C9A06A",
              marginTop: 7,
              flexShrink: 0,
            }}
          />
          <span style={{ wordBreak: "break-word" }}>{text}</span>
        </div>
      </div>
    );
  }

  if (m.kind === "user") {
    return (
      <div
        // data-msg-id lets RecentRail.scrollToAnchor(id) find this row
        // by attribute selector and call scrollIntoView. Mounted on the
        // outer wrapper (rather than the inner bubble) so the highlight
        // outline below covers the whole gutter on flash.
        data-msg-id={m.id}
        style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}
      >
        <div
          style={{
            maxWidth: 280,
            background: "#5D3000",
            color: "#FAF8F6",
            padding: "10px 14px",
            borderRadius: 14,
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 13.5,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {m.text}
        </div>
      </div>
    );
  }

  if (m.kind === "assistant") {
    // Empty assistant bubble while a stream is in flight is just visual
    // noise — the reasoning card right below already carries the "AI
    // is working" semantics with its own pulse + ticking timer. We hide
    // the bubble entirely until the first token actually lands, then
    // the cursor takes over until done.
    if (!m.text && isLastAssistant && streaming) return null;

    return (
      <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "#5D3000",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <VantageMark />
        </div>
        <div
          style={{
            background: "#FFFFFF",
            border: "1px solid #EDE8DF",
            color: "#2B2822",
            padding: "10px 14px",
            borderRadius: 14,
            minWidth: 0,
            flex: 1,
          }}
        >
          {m.text ? (
            <MarkdownMessage content={m.text} />
          ) : (
            // Step 2: replace the bare ellipsis with a visible "Thinking"
            // affordance — Manus-style. The narrator chip / agent rows
            // carry the *what*; this is the bubble's own "I'm still here"
            // signal between deltas.
            <span
              style={{
                color: "#7C7367",
                fontFamily: "Inter, system-ui, sans-serif",
                fontStyle: "italic",
                fontSize: 13,
              }}
            >
              {t("message.thinking")}
            </span>
          )}
          {isLastAssistant && streaming ? <StreamingCursor /> : null}
        </div>
      </div>
    );
  }

  if (m.kind === "agents") {
    if (!m.agents || m.agents.length === 0) return null;
    return <AgentsGroupRow ids={m.agents} />;
  }

  if (m.kind === "result") {
    return (
      <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }} className="animate-pop">
        <div style={{ width: 28, flexShrink: 0 }} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "#FFFBF4",
            border: "1px solid #E8DCCA",
            borderRadius: 12,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 11,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: "#EBF3E5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#4C7A3F" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="M22 4L12 14.01l-3-3" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: "#2B2822" }}>
                {m.title}
              </div>
              <div style={{ marginTop: 2 }}>
                {m.sub ? (
                  <MarkdownMessage content={m.sub} variant="subline" />
                ) : null}
              </div>
            </div>
          </div>
          {m.action && m.onAction && (
            <button
              onClick={m.onAction}
              style={{
                cursor: "pointer",
                border: "none",
                background: "#5D3000",
                color: "#FAF8F6",
                fontFamily: "Inter",
                fontWeight: 600,
                fontSize: 13,
                padding: 10,
                borderRadius: 8,
              }}
            >
              {m.action}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (m.kind === "task_graph") {
    return <TaskGraphCard m={m} />;
  }

  if (m.kind === "artifact") {
    return <ArtifactCard m={m} />;
  }

  if (
    m.kind === "hitl_ask_user" ||
    m.kind === "hitl_diff" ||
    m.kind === "hitl_approval"
  ) {
    return <HitlCard m={m} />;
  }

  return null;
}

// Generic artifact card. Renders title, confidence pill, evidence list
// and primary actions. Per audit P2.2 — all agent outputs share one
// shape, so we don't need a separate renderer per artifact_type. The
// "Approve" / "Tweak" / "Discard" copy comes from next_actions[].
function ArtifactCard({ m }: { m: DockMessage }) {
  const t = useTranslations("dock");
  const a = m.artifact;
  if (!a) return null;
  const confPct = typeof a.confidence === "number" ? Math.round(a.confidence * 100) : null;
  const confSpec = (() => {
    if (confPct === null) return null;
    if (confPct >= 80) return { text: t("artifact.confident", { pct: confPct }), fg: "#2F5722", bg: "#E2EED9" };
    if (confPct >= 60) return { text: t("artifact.confident", { pct: confPct }), fg: "#5D3000", bg: "#FBEFD8" };
    return { text: t("artifact.review", { pct: confPct }), fg: "#8A6A12", bg: "#FBEFD0" };
  })();
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }} className="animate-pop">
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: "#FFFBF4",
          border: "1px solid #E8DCCA",
          borderRadius: 12,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 11,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div
            style={{
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
              fontSize: 9.5,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "#A39F99",
            }}
          >
            {a.artifactType.replace(/_/g, " ")}
          </div>
          {confSpec ? (
            <span
              style={{
                fontFamily: "JetBrains Mono, ui-monospace, monospace",
                fontSize: 9.5,
                letterSpacing: 0.6,
                padding: "2px 7px",
                borderRadius: 999,
                color: confSpec.fg,
                background: confSpec.bg,
              }}
            >
              {confSpec.text}
            </span>
          ) : null}
          {a.needsUserReview ? (
            <span
              style={{
                fontFamily: "JetBrains Mono, ui-monospace, monospace",
                fontSize: 9.5,
                letterSpacing: 0.6,
                padding: "2px 7px",
                borderRadius: 999,
                color: "#7A2A1F",
                background: "#F4D7D2",
              }}
            >
              HITL
            </span>
          ) : null}
        </div>
        <div>
          <div style={{ fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, fontSize: 14, color: "#2B2822" }}>
            {a.artifactTitle}
          </div>
          {a.artifactSub ? (
            <div style={{ marginTop: 2 }}>
              <MarkdownMessage content={a.artifactSub} variant="subline" />
            </div>
          ) : null}
        </div>
        {a.sourceEvidence && a.sourceEvidence.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              style={{
                fontFamily: "JetBrains Mono, ui-monospace, monospace",
                fontSize: 9.5,
                letterSpacing: 0.6,
                color: "#A39F99",
              }}
            >
              {t("artifact.evidence")}
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              {a.sourceEvidence.map((ev, i) => (
                <li
                  key={i}
                  style={{
                    fontFamily: "Inter, system-ui, sans-serif",
                    fontSize: 12,
                    color: "#5D5046",
                  }}
                >
                  {ev.route ? (
                    <a
                      href={ev.route}
                      style={{ color: "#5D3000", textDecoration: "underline" }}
                    >
                      {ev.label}
                    </a>
                  ) : (
                    ev.label
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {a.artifactType === "suggestion_list" && a.suggestions && a.suggestions.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {a.suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                messageId={m.id}
                suggestion={s}
                sourceResumeId={a.sourceResumeId}
              />
            ))}
          </div>
        ) : null}
        {a.nextActions && a.nextActions.length > 0 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {a.nextActions.map((act, i) => (
              <ArtifactActionButton key={i} action={act} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// One accept/reject card inside a suggestion_list artifact (design §6.3).
// Deciding hits /api/resumes/suggestions/:id/decision and greys the card out
// in place — no page jump, the whole point of "vibe in the dock".
function SuggestionCard({
  messageId,
  suggestion,
  sourceResumeId,
}: {
  messageId: string;
  suggestion: ArtifactSuggestion;
  sourceResumeId?: string;
}) {
  const t = useTranslations("dock");
  const [busy, setBusy] = useState(false);
  const [discussInstruction, setDiscussInstruction] = useState<string | null>(null);
  const decided = suggestion.decided;

  async function decide(decision: "accept" | "reject") {
    if (busy || decided) return;
    setBusy(true);
    try {
      await resumesApi.decideSuggestion(suggestion.id, decision, "dock_inline");
    } catch {
      setBusy(false);
      return;
    }
    // Mark this suggestion decided in the stored artifact so the card greys
    // out without refetching the whole turn.
    const dock = useDock.getState();
    const msg = dock.messages.find((x) => x.id === messageId);
    const arr = msg?.artifact?.suggestions;
    if (arr) {
      dock.patchMessage(messageId, {
        artifact: {
          ...msg!.artifact!,
          suggestions: arr.map((x) =>
            x.id === suggestion.id
              ? { ...x, decided: decision === "accept" ? "accepted" : "rejected" }
              : x,
          ),
        },
      });
    }
    setBusy(false);
  }

  // [Discuss] opens an inline bullet-scoped vibe input (design §6.3). Submitting
  // calls propose_bullet_edit for THIS bullet and swaps the revised text into
  // the card — a one-bullet conversation without leaving the dock. Falls back
  // to a scoped dock prompt when we don't have the source résumé id or a stable
  // bullet id (older artifacts).
  function openDiscuss() {
    if (!sourceResumeId || !suggestion.bulletStableId) {
      const dock = useDock.getState();
      dock.open();
      dock.setInput(t("suggestion.discussSeed", { bullet: suggestion.beforeText }));
      return;
    }
    setDiscussInstruction("");
  }

  async function submitDiscuss() {
    const instruction = (discussInstruction ?? "").trim();
    if (!instruction || !sourceResumeId || !suggestion.bulletStableId || busy) return;
    setBusy(true);
    try {
      const res = await resumesApi.bulletEdit(
        sourceResumeId,
        suggestion.bulletStableId,
        instruction,
      );
      if (res.ok && res.suggestion) {
        const dock = useDock.getState();
        const msg = dock.messages.find((x) => x.id === messageId);
        const arr = msg?.artifact?.suggestions;
        if (arr) {
          // The revised suggestion supersedes this card in place — new id,
          // new text, fresh (undecided) state.
          dock.patchMessage(messageId, {
            artifact: {
              ...msg!.artifact!,
              suggestions: arr.map((x) =>
                x.id === suggestion.id
                  ? {
                      id: res.suggestion!.id,
                      bulletStableId: res.suggestion!.bullet_stable_id,
                      section: res.suggestion!.section,
                      changeType: res.suggestion!.change_type,
                      beforeText: res.suggestion!.before_text,
                      afterText: res.suggestion!.after_text,
                      rationale: res.suggestion!.rationale,
                      riskLevel: res.suggestion!.risk_level,
                    }
                  : x,
              ),
            },
          });
        }
        setDiscussInstruction(null);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid #EAE0D0",
        borderRadius: 10,
        padding: 11,
        background: decided ? "#F4F1EA" : "#FFFFFF",
        opacity: decided ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <span
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 9,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "#A39F99",
          }}
        >
          {suggestion.changeType}
        </span>
        {suggestion.riskLevel === "needs_review" && !decided ? (
          <span
            style={{
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
              fontSize: 8,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "#A66A00",
              background: "#FBEFD8",
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            {t("suggestion.needsReview")}
          </span>
        ) : null}
        {decided ? (
          <span style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, color: "#6B6560" }}>
            {decided === "accepted" ? t("suggestion.accepted") : t("suggestion.rejected")}
          </span>
        ) : null}
      </div>
      <div style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, color: "#A39F99", textDecoration: "line-through", marginBottom: 3 }}>
        {suggestion.beforeText}
      </div>
      <div style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 13, color: "#2B2822", marginBottom: suggestion.rationale ? 5 : 8 }}>
        {suggestion.afterText}
      </div>
      {suggestion.rationale ? (
        <div style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 11.5, color: "#6B6560", marginBottom: 8 }}>
          {suggestion.rationale}
        </div>
      ) : null}
      {!decided ? (
        <div style={{ display: "flex", gap: 7 }}>
          <button
            onClick={() => decide("accept")}
            disabled={busy}
            style={{
              cursor: busy ? "default" : "pointer",
              border: "1px solid #4C7A3F",
              background: "#4C7A3F",
              color: "#FFFFFF",
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 12,
              padding: "5px 12px",
              borderRadius: 8,
            }}
          >
            {t("suggestion.accept")}
          </button>
          <button
            onClick={() => decide("reject")}
            disabled={busy}
            style={{
              cursor: busy ? "default" : "pointer",
              border: "1px solid #D6CEC0",
              background: "#FFFFFF",
              color: "#6B6560",
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 12,
              padding: "5px 12px",
              borderRadius: 8,
            }}
          >
            {t("suggestion.reject")}
          </button>
          <button
            onClick={openDiscuss}
            style={{
              cursor: "pointer",
              border: "none",
              background: "transparent",
              color: "#5D3000",
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 12,
              padding: "5px 8px",
            }}
          >
            {t("suggestion.discuss")}
          </button>
        </div>
      ) : null}
      {discussInstruction !== null && !decided ? (
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <input
            autoFocus
            value={discussInstruction}
            onChange={(e) => setDiscussInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitDiscuss();
              if (e.key === "Escape") setDiscussInstruction(null);
            }}
            placeholder={t("suggestion.discussPlaceholder")}
            style={{
              flex: 1,
              minWidth: 0,
              border: "1px solid #D6CEC0",
              borderRadius: 8,
              padding: "6px 9px",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12,
              color: "#2B2822",
              background: "#FFFFFF",
            }}
          />
          <button
            onClick={submitDiscuss}
            disabled={busy || !discussInstruction.trim()}
            style={{
              cursor: busy ? "default" : "pointer",
              border: "1px solid #5D3000",
              background: "#5D3000",
              color: "#FFFFFF",
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 12,
              padding: "6px 11px",
              borderRadius: 8,
            }}
          >
            {t("suggestion.revise")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ArtifactActionButton({ action }: { action: ArtifactAction }) {
  const onClick = action.route
    ? () => {
        if (typeof window !== "undefined") window.location.assign(action.route!);
      }
    : undefined;
  // Three color tracks: primary (approve/open), neutral (tweak), warn
  // (discard). Keeps the dock visually consistent with the result card
  // while letting users see "this is the destructive one" at a glance.
  const style: React.CSSProperties = (() => {
    if (action.kind === "approve" || action.kind === "open") {
      return {
        background: "#5D3000",
        color: "#FAF8F6",
        border: "none",
      };
    }
    if (action.kind === "discard") {
      return {
        background: "#FFFFFF",
        color: "#7A2A1F",
        border: "1px solid #E2C1BB",
      };
    }
    return {
      background: "#FFFFFF",
      color: "#2B2822",
      border: "1px solid #E8DCCA",
    };
  })();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        ...style,
        cursor: onClick ? "pointer" : "not-allowed",
        opacity: onClick ? 1 : 0.5,
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: 600,
        fontSize: 12.5,
        padding: "8px 12px",
        borderRadius: 8,
      }}
    >
      {action.label}
    </button>
  );
}

// Render the coordinator's plan as a row-per-step card. Each row mirrors
// the (agent, label, status) tuple; the status pill animates as
// updateTaskGraphStep mutates the row. We intentionally keep it visually
// quieter than the result card so a typical 3-step plan doesn't crowd
// out the conversation thread above and below it.
function TaskGraphCard({ m }: { m: DockMessage }) {
  const t = useTranslations("dock");
  if (!m.steps || m.steps.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }} className="animate-pop">
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: "#FFFFFF",
          border: "1px solid #EDE8DF",
          borderRadius: 12,
          padding: "12px 14px",
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 10,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "#A39F99",
            marginBottom: 6,
          }}
        >
          {t("taskGraph.planHeader", { count: m.steps.length })}
        </div>
        {m.userGoal ? (
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 13,
              color: "#2B2822",
              marginBottom: 9,
            }}
          >
            {m.userGoal}
          </div>
        ) : null}
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {m.steps.map((s, i) => (
            <li
              key={s.step}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12.5,
                color: s.status === "pending" ? "#A39F99" : "#2B2822",
              }}
            >
              <span
                aria-hidden
                style={{
                  fontFamily: "JetBrains Mono, ui-monospace, monospace",
                  fontSize: 10,
                  width: 14,
                  flexShrink: 0,
                  color: "#A39F99",
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{s.label}</span>
              <TaskGraphStepPill status={s.status} requiresReview={!!s.requires_review} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function TaskGraphStepPill({
  status,
  requiresReview,
}: {
  status: "pending" | "running" | "done" | "review" | "failed";
  requiresReview: boolean;
}) {
  const t = useTranslations("dock");
  const spec = (() => {
    if (status === "running") return { text: t("taskGraph.running"), fg: "#5D3000", bg: "#FBEFD8", anim: true };
    if (status === "done") return { text: t("taskGraph.done"), fg: "#2F5722", bg: "#E2EED9" };
    if (status === "review") return { text: t("taskGraph.review"), fg: "#8A6A12", bg: "#FBEFD0" };
    if (status === "failed") return { text: t("taskGraph.failed"), fg: "#7A2A1F", bg: "#F4D7D2" };
    return { text: requiresReview ? "HITL" : t("taskGraph.waiting"), fg: "#A39F99", bg: "#F4F0E8" };
  })();
  return (
    <span
      className={spec.anim ? "animate-pulse" : undefined}
      style={{
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 9.5,
        letterSpacing: 0.6,
        padding: "2px 7px",
        borderRadius: 999,
        color: spec.fg,
        background: spec.bg,
        flexShrink: 0,
      }}
    >
      {spec.text}
    </span>
  );
}

function dockShellStyle(width: number): React.CSSProperties {
  return {
    position: "relative",
    width,
    minWidth: 280,
    maxWidth: 560,
    flexShrink: 0,
    background: "#FBF8F3",
    borderLeft: "1px solid #EDE8DF",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    transition: "width 0.16s ease-out",
  };
}

// Relative-time formatter for the RECENT rail. Resolution drops as
// distance grows so we don't pretend to know seconds-old precision a
// week later. Intl.RelativeTimeFormat would be fine, but writing it out
// keeps the bundle small and dock typography consistent.
// `tr` is the dock-namespace translator passed down from RecentRail (this is
// a module-level helper, so it can't call useTranslations itself).
function relativeTime(
  iso: string,
  tr: (key: string, values?: Record<string, string | number>) => string,
): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return tr("recent.justNow");
  if (diff < 3_600_000) return tr("recent.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return tr("recent.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return tr("recent.daysAgo", { count: Math.floor(diff / 86_400_000) });
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// RecentRail — the dock's history strip in "full" layout. Anchors-only
// model (vantage-ui-mapping §1.2): each row is a past user prompt; click
// scrolls the main chat list back to that turn and pulses a brief
// highlight ring on the bubble. We never switch threads. Empty state
// stays helpful instead of preachy.
function RecentRail({ scrollRoot }: { scrollRoot: React.RefObject<HTMLDivElement | null> }) {
  const t = useTranslations("dock");
  const anchors = useDock((s) => s.recentAnchors);
  const [pulseId, setPulseId] = useState<string | null>(null);

  const scrollToAnchor = (id: string) => {
    const root = scrollRoot.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!target) {
      // Anchor exists on the server but not yet in the in-memory log
      // (e.g. user just landed and their first scroll-back targets a
      // turn from a previous session). Until we wire full history
      // hydration, give a soft signal that we know the anchor exists
      // but can't navigate to it.
      setPulseId(`miss:${id}`);
      window.setTimeout(() => setPulseId(null), 800);
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setPulseId(id);
    window.setTimeout(() => setPulseId(null), 1400);
  };

  // Mirror pulse → DOM via an inline outline. Keeps the highlight side
  // effect colocated with the rail rather than threading another piece
  // of state into MessageRow.
  useEffect(() => {
    if (!pulseId || pulseId.startsWith("miss:")) return;
    const root = scrollRoot.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(pulseId)}"]`);
    if (!target) return;
    const prev = target.style.outline;
    const prevOffset = target.style.outlineOffset;
    const prevRadius = target.style.borderRadius;
    target.style.outline = "2px solid #A66A00";
    target.style.outlineOffset = "4px";
    target.style.borderRadius = "14px";
    return () => {
      target.style.outline = prev;
      target.style.outlineOffset = prevOffset;
      target.style.borderRadius = prevRadius;
    };
  }, [pulseId, scrollRoot]);

  if (anchors.length === 0) {
    return (
      <div className="ds-caption" style={{ padding: "12px 8px", color: "#A39F99" }}>
        {t("recent.empty")}
      </div>
    );
  }

  return (
    // Tighter rhythm — vantage-ui-mapping.md §0 "Vantage is one
    // conversation": the RECENT rail is a glanceable index, not
    // featured content. Reduced row gap + padding + leading so a
    // long history fits without scrolling and visually defers to
    // the live conversation column on the right.
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {anchors.map((a) => {
        const isMiss = pulseId === `miss:${a.id}`;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => scrollToAnchor(a.id)}
            title={a.preview}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "block",
              padding: "6px 8px",
              borderRadius: 8,
              transition: "background .12s ease-out",
              background: isMiss ? "#FCE9E1" : "transparent",
            }}
            onMouseEnter={(e) => {
              if (!isMiss) e.currentTarget.style.background = "#F5EDE3";
            }}
            onMouseLeave={(e) => {
              if (!isMiss) e.currentTarget.style.background = "transparent";
            }}
          >
            <div
              style={{
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12.5,
                lineHeight: 1.35,
                color: "#2B2822",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {a.preview}
            </div>
            <div
              className="ds-mono-9"
              style={{ marginTop: 1, color: isMiss ? "#A23A2E" : "#A39F99" }}
            >
              {isMiss ? t("recent.olderOpenThread") : relativeTime(a.createdAt, t)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function AskVantageDock() {
  const t = useTranslations("dock");
  const state = useDock((s) => s.state);
  const width = useDock((s) => s.width);
  const setWidth = useDock((s) => s.setWidth);
  const messages = useDock((s) => s.messages);
  const input = useDock((s) => s.input);
  const setInput = useDock((s) => s.setInput);
  const streaming = useDock((s) => s.streaming);
  const toggleFull = useDock((s) => s.toggleFull);
  const toggleDock = useDock((s) => s.toggleDock);
  const hintedCollapse = useDock((s) => s.hintedCollapse);

  // Pathname picks the chip groups per §2.6 (post-merger): on /app/studio/
  // resume we show This-résumé + Explore; everywhere else just Explore.
  // The old left-rail VibeChatPanel is gone — the dock is now the single
  // conversation entry, and per-surface chip groups carry the scope.
  const pathname = usePathname();
  const chipGroups = useMemo(() => chipGroupsForPath(pathname), [pathname]);

  const currentUser = useVantage((s) => s.currentUser);
  const currentResumeId = useVantage((s) => s.currentResumeId);
  const parsedResume = useVantage((s) => s.parsedResume);
  // N1 (round-2): the dock is the always-on surface, so it's the natural
  // place to confirm "your résumé upload is being processed" without
  // pulling the user back to the onboarding screen. Read the workspace
  // store's async parse state and forward it to the Greeting subcomponent.
  const parseJobStatus = useVantage((s) => s.parseJobStatus);
  // Match the sidebar's precedence: prefer the name the user wrote on their
  // résumé over the auth display_name. Auth display_name can be blank or
  // backfilled from the email local-part (the source of QA bug #5: the
  // avatar showed "N" because the user's email started with "n", not their
  // real name "XIONG"). Sidebar + dock + greeting now agree.
  const firstName = useMemo(() => {
    const resumeName = parsedResume?.basics?.name?.trim() ?? "";
    const auth = currentUser?.displayName?.trim() ?? "";
    const source = resumeName || auth;
    const first = source.split(/\s+/)[0] ?? "";
    // Empty when nameless — the render site (`who`) supplies the localized
    // fallback via t("greeting.fallbackName"), so we don't hardcode "there".
    return first;
  }, [parsedResume, currentUser]);

  // Surface + thread override for chips inside the "This résumé" group.
  // Sending a scoped chip swaps the dock conversation onto the
  // `resume_studio:{user_id}:{root_id}` thread so the resume_agent has the
  // right per-branch checkpointer history. The dock's own ask_vantage
  // thread continues to back every other interaction (free-text composer,
  // Explore chips, agent-team mentions).
  //
  // We use currentResumeId as the root id stand-in until the store
  // exposes a root pointer; for the Master version that's already the
  // master id, for tailored variants it's the variant's id — slightly
  // looser than the studio's own root resolution, but the
  // post-merger UX intentionally treats "this résumé" as "whatever is
  // on screen right now". The studio's branch-vs-master nuance survives
  // in §2.6's docs and can be tightened later by threading the actual
  // root via the store.
  const resumeStudioThread = useMemo(() => {
    if (!currentUser || !currentResumeId) return null;
    return `resume_studio:${currentUser.id}:${currentResumeId}`;
  }, [currentUser, currentResumeId]);

  const attachments = useDock((s) => s.attachments);

  const dragging = useRef<{ startX: number; startW: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hintedCollapse && state === "docked") {
      useDock.setState({ state: "closed" });
    }
  }, [hintedCollapse, state]);

  // C1 (round-1): isolate dock messages per effective thread.
  // The dock owns a single in-memory `messages` array that previously
  // followed the user across surfaces — so resume_studio turns from one
  // résumé leaked into the lifetime ask_vantage thread on the next page,
  // and vice versa. vantage-ui-mapping.md §2.6 explicitly promises that
  // the dock conversation is *scoped* on /app/studio/resume — the
  // subtitle changes, the chips change, but until now the message
  // history kept appending. This effect clears the in-memory list when
  // the effective thread changes, so each thread starts visually clean
  // and PostgresSaver-backed history is re-fetched on the next user
  // turn. recentAnchors live on the store and survive — they're the
  // lifetime ask_vantage rail and are explicitly cross-thread by design.
  const effectiveThread = useMemo(() => {
    return pathname?.startsWith("/app/studio/resume") && resumeStudioThread
      ? resumeStudioThread
      : "ask_vantage";
  }, [pathname, resumeStudioThread]);
  const prevEffectiveThread = useRef<string>(effectiveThread);
  useEffect(() => {
    if (prevEffectiveThread.current !== effectiveThread) {
      prevEffectiveThread.current = effectiveThread;
      useDock.getState().reset();
    }
  }, [effectiveThread]);

  // Unmount-time SSE cleanup. The dock is re-mounted by AppLayout every time
  // `screen` flips between the workspace and an overlay (review / extension /
  // builder / mock / onboarding) — six separate <AskVantageDock/> render
  // sites. Without this, an in-flight NDJSON reader on /api/ask/stream keeps
  // pulling bytes after the React tree is gone, leaking memory and event
  // dispatch into a dead store subscription. `cancelStream()` calls
  // AbortController.abort(); the fetch promise rejects with AbortError
  // (already handled in ask-stream.ts) and the reader returns.
  useEffect(() => {
    return () => {
      const dock = useDock.getState();
      if (dock.streaming || dock.abortController) {
        dock.cancelStream();
      }
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const dx = dragging.current.startX - e.clientX;
      setWidth(dragging.current.startW + dx);
    }
    function onUp() {
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setWidth]);

  function startResize(e: React.MouseEvent) {
    dragging.current = { startX: e.clientX, startW: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function submit() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    // Empty body but with attachments? Use a friendly default verb so the
    // agent has something to reason about.
    const finalPrompt = text || t("reviewAttachments");
    // On Resume Studio with a résumé loaded, free-text composer turns join
    // the same resume_studio thread the chips use. That's what makes the
    // dock the *single* conversation entry: clicking "Find my résumé's 3
    // weakest spots" and then typing "now redo the second one as STAR
    // format" must land in the same conversation — anything else and we
    // re-introduce the dual-input problem the merger was supposed to fix.
    const sendOpts =
      pathname?.startsWith("/app/studio/resume") && resumeStudioThread
        ? { surface: "resume_studio" as const, threadIdOverride: resumeStudioThread }
        : undefined;
    void sendAsk(finalPrompt, attachments, sendOpts);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  if (state === "closed") {
    // Slim launcher — vantage-ui-mapping.md §0 spec: "54px slim
    // launcher". A floating brand-cream pill (vs. the previous solid
    // brown chip) so the closed dock reads as "the conversation is
    // resting here", not "press this big button". Vertical, brand-mark
    // only, with a calm shadow that mirrors the composer's lifted
    // card — the two surfaces feel like one design language.
    return (
      <button
        onClick={toggleDock}
        data-tour="dock"
        type="button"
        title={t("openAskVantage")}
        aria-label={t("openAskVantage")}
        style={{
          position: "fixed",
          bottom: 26,
          right: 16,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: 54,
          height: 116,
          background: "#FAF8F6",
          color: "#5D3000",
          border: "1px solid rgba(40,25,5,.08)",
          borderRadius: 27,
          padding: "14px 0",
          // Lifted-card shadow — same tone as the composer card so the
          // dock surfaces read as one floating-paper family.
          boxShadow:
            "0 1px 2px rgba(40,25,5,.05), 0 12px 32px rgba(40,25,5,.10)",
          cursor: "pointer",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          transition:
            "background .18s ease, transform .18s ease, box-shadow .18s ease, border-color .18s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "#FFFFFF";
          e.currentTarget.style.transform = "translateY(-1px)";
          e.currentTarget.style.borderColor = "rgba(93,48,0,.18)";
          e.currentTarget.style.boxShadow =
            "0 2px 4px rgba(40,25,5,.06), 0 16px 40px rgba(40,25,5,.14)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "#FAF8F6";
          e.currentTarget.style.transform = "translateY(0)";
          e.currentTarget.style.borderColor = "rgba(40,25,5,.08)";
          e.currentTarget.style.boxShadow =
            "0 1px 2px rgba(40,25,5,.05), 0 12px 32px rgba(40,25,5,.10)";
        }}
      >
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "#5D3000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#FAF8F6",
          }}
        >
          <VantageMark size={16} />
        </span>
        <span
          aria-hidden
          style={{
            // Vertical "ASK" — visual signature like the agent status
            // chips (COORDINATOR · THINKING) up in the dock header.
            // writing-mode tilts the text so it reads bottom-to-top.
            writingMode: "vertical-rl",
            transform: "rotate(180deg)",
            fontSize: 9,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "#A39F99",
          }}
        >
          {t("askVertical")}
        </span>
      </button>
    );
  }

  const hasLog = messages.length > 0;
  const isFull = state === "full";

  return (
    <aside
      data-tour="dock"
      style={
        isFull
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 40,
              background: "#FBF8F3",
              display: "flex",
              flexDirection: "column",
            }
          : dockShellStyle(width)
      }
    >
      {!isFull && (
        <div
          onMouseDown={startResize}
          title={t("dragToResize")}
          style={{
            position: "absolute",
            left: -3,
            top: 0,
            bottom: 0,
            width: 7,
            cursor: "col-resize",
            zIndex: 10,
            transition: "background .14s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#E8DCCA")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        />
      )}

      <div
        className="ds-backdrop"
        style={{
          height: 60,
          flexShrink: 0,
          borderBottom: "1px solid #EDE8DF",
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "0 12px 0 18px",
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "#5D3000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <VantageMark size={15} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 14,
              color: "#2B2822",
              lineHeight: 1.1,
            }}
          >
            {t("askVantage")}
          </div>
          {/* Scope strip: on Resume Studio with a résumé loaded, we make it
              clear which conversation track is live so the chip-vs-composer
              behavior is obvious. Everywhere else the original "always
              here" tagline still carries the dock's persistent-companion
              identity. */}
          {pathname?.startsWith("/app/studio/resume") && resumeStudioThread ? (
            <div className="ds-mono-9" style={{ color: "#5D3000" }}>
              {t("subtitleResume")}
            </div>
          ) : (
            <div className="ds-mono-9">{t("subtitleDefault")}</div>
          )}
        </div>
        <button
          onClick={toggleFull}
          title={isFull ? t("dockButton") : t("expandButton")}
          style={iconBtnStyle()}
          aria-label={isFull ? t("dockButton") : t("expandButton")}
        >
          {isFull ? (
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          )}
        </button>
        <button
          onClick={toggleDock}
          title={t("collapse")}
          style={iconBtnStyle()}
          aria-label={t("collapse")}
        >
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        {isFull && (
          <aside
            style={{
              width: 264,
              flexShrink: 0,
              borderRight: "1px solid #EDE8DF",
              background: "#FBF8F3",
              overflowY: "auto",
              padding: "22px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px 12px" }}>
              <span className="ds-label" style={{ color: "#6B6560" }}>{t("recentLabel")}</span>
              <button
                onClick={() => useDock.getState().reset()}
                title={t("newChat")}
                style={smallIconBtnStyle()}
                aria-label={t("newChat")}
              >
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <RecentRail scrollRoot={scrollRef} />
          </aside>
        )}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "22px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {!hasLog && (
              <Greeting
                firstName={firstName}
                streaming={streaming}
                chipGroups={chipGroups}
                resumeStudioThread={resumeStudioThread}
                parseJobStatus={parseJobStatus}
              />
            )}
            {(() => {
              // Identify the most recent assistant bubble so only it
              // gets the trailing <StreamingCursor/>. Doing the scan
              // once outside the map keeps it O(n) and avoids passing
              // a "last index" through every row.
              let lastAssistantIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].kind === "assistant") {
                  lastAssistantIdx = i;
                  break;
                }
              }
              return messages.map((m, idx) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  isLastAssistant={idx === lastAssistantIdx}
                  streaming={streaming}
                />
              ));
            })()}
            {/* Previously a bottom-of-list "VantageMark + ThinkingDots"
                bubble used to signal streaming. With the per-bubble
                <StreamingCursor/> + the ReasoningSummary thinking pulse,
                that third indicator was redundant — three things saying
                "I'm thinking" at once. Kept the comment so the next
                person doesn't reintroduce it. */}
          </div>
          <Composer
            input={input}
            setInput={setInput}
            onSubmit={submit}
            onKeyDown={onKeyDown}
            streaming={streaming}
          />
        </div>
      </div>
    </aside>
  );
}

function Greeting({
  firstName,
  streaming,
  chipGroups,
  resumeStudioThread,
  parseJobStatus,
}: {
  firstName: string;
  streaming: boolean;
  chipGroups: { meta: SuggestionGroup; chips: SuggestionChip[] }[];
  // When non-null and a "This résumé" chip fires, the SSE turn goes to
  // this thread instead of the dock's lifetime ask_vantage thread. Null
  // on every non-Resume route or when no résumé is selected yet.
  resumeStudioThread: string | null;
  // N1 (round-2): mirrors workspace store state so the dock greeting
  // paragraph can confirm an upload in flight, surface a parse failure,
  // or fall back to the normal "what should we work on" copy.
  parseJobStatus: "idle" | "running" | "done" | "failed";
}) {
  const t = useTranslations("dock");
  // Single source of truth for date + greeting: greetingFor() and the same
  // Intl.DateTimeFormat call as the Today header so the dock can never
  // disagree with the main view (bug #1 from the QA pass — dock said "Good
  // morning" while Today said "Good evening" at the same moment).
  const today = useMemo(() => {
    const d = new Date();
    return d
      .toLocaleDateString(undefined, {
        weekday: "short",
        day: "2-digit",
        month: "short",
      })
      .toUpperCase();
  }, []);
  // Map the English time-of-day from greetingFor() onto a localized word so
  // the greeting follows the UI locale (greetingFor lives in @/lib/dates and
  // is locale-agnostic by design — we localize at the render site).
  const greeting = useMemo(() => {
    const g = greetingFor();
    const key =
      g === "Good morning"
        ? "morning"
        : g === "Good afternoon"
          ? "afternoon"
          : "evening";
    return t(`greeting.timeOfDay.${key}`);
  }, [t]);
  const who = firstName?.trim() || t("greeting.fallbackName");
  return (
    <div className="animate-fade-up">
      <div className="ds-mono-10" style={{ marginBottom: 10 }}>{t("greeting.today", { date: today })}</div>
      <h1 className="ds-h2" style={{ margin: "0 0 7px", color: "#2B2822" }}>
        {t("greeting.headline", { greeting, name: who })}
      </h1>
      {parseJobStatus === "running" ? (
        // N1 (round-2): when an async résumé parse is in flight, the dock
        // greeting paragraph is the single quiet place we can confirm the
        // upload was accepted and the system is working on it. Otherwise a
        // user who just hit "Upload" sees nothing change in the dock and
        // wonders if the file went anywhere. Once status flips to "done" or
        // "failed" the onboarding banner takes over the loud part — the dock
        // paragraph returns to its normal "What should we work on" copy.
        <p className="ds-body-sm" style={{ color: "#6B6560", margin: "0 0 20px" }}>
          {t("greeting.parseRunning")}
        </p>
      ) : parseJobStatus === "failed" ? (
        <p className="ds-body-sm" style={{ color: "#A66A00", margin: "0 0 20px" }}>
          {t("greeting.parseFailed")}
        </p>
      ) : (
        <p className="ds-body-sm" style={{ color: "#6B6560", margin: "0 0 20px" }}>
          {t("greeting.parseIdle")}
        </p>
      )}

      {chipGroups.map((group, gi) => {
        const isScoped = group.meta.id === "this_resume";
        // Disable scoped chips when the thread isn't ready yet (no user or
        // no résumé selected). Keeps the chip visible so the layout doesn't
        // jump, but prevents a click from firing into ask_vantage by
        // accident.
        const scopedDisabled = isScoped && resumeStudioThread == null;
        return (
          <div
            key={group.meta.id}
            // Top margin only on subsequent groups; first group flows under
            // the greeting paragraph's spacing.
            style={{ marginTop: gi === 0 ? 0 : 22 }}
          >
            {/* Group header — only render when there's more than one group.
                On non-Resume routes we have a single "Explore" group; a
                heading would just be noise. */}
            {chipGroups.length > 1 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 9,
                  marginBottom: 10,
                }}
              >
                <span
                  className="ds-mono-10"
                  style={{ color: "#5D3000" }}
                >
                  {t(group.meta.labelKey).toUpperCase()}
                </span>
                {group.meta.scopeHintKey ? (
                  <span
                    style={{
                      fontFamily: "Inter, system-ui, sans-serif",
                      fontSize: 11.5,
                      color: "#A39F99",
                    }}
                  >
                    {t(group.meta.scopeHintKey)}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {group.chips.map((chip) => {
                const chipDisabled = streaming || scopedDisabled;
                const sendOpts = isScoped && resumeStudioThread
                  ? { surface: "resume_studio" as const, threadIdOverride: resumeStudioThread }
                  : undefined;
                const chipDisplay = t(chip.displayKey);
                return (
                  <button
                    key={`${group.meta.id}:${chip.displayKey}`}
                    onClick={() => {
                      if (chipDisabled) return;
                      // Quick-prompt chips bypass the composer and fire
                      // straight at the coordinator. Scoped chips ride the
                      // resume_studio thread; the rest stay on ask_vantage.
                      void sendAsk(chip.prompt, [], sendOpts);
                    }}
                    disabled={chipDisabled}
                    className="ds-card"
                    title={
                      scopedDisabled
                        ? t("chips.scopedDisabledHint")
                        : chip.prompt !== chipDisplay
                          ? chip.prompt
                          : undefined
                    }
                    style={{
                      cursor: chipDisabled ? "not-allowed" : "pointer",
                      padding: "12px 14px",
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      transition: "border-color .15s, transform .15s",
                      textAlign: "left",
                      width: "100%",
                      opacity: chipDisabled ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (chipDisabled) return;
                      e.currentTarget.style.borderColor = "#5D3000";
                      e.currentTarget.style.transform = "translateY(-1px)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "#EDE8DF";
                      e.currentTarget.style.transform = "translateY(0)";
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: "#F5EDE3",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#5D3000" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13 2L3 14h7l-1 8 10-12h-7z" />
                      </svg>
                    </div>
                    <span style={{ fontFamily: "Inter", fontWeight: 500, fontSize: 13.5, color: "#2B2822" }}>
                      {chipDisplay}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="ds-mono-10" style={{ margin: "28px 0 10px", color: "#A39F99" }}>
        {t("agentTeamsLabel")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {AGENT_TEAMS.map((team) => (
          <button
            key={team.slug}
            onClick={() => {
              if (streaming) return;
              // Mention the team in the composer; user types the follow-up
              // verb after the chip seeds the conversation.
              useDock.getState().setInput(`${team.slug} `);
              setTimeout(() => {
                const ta = document.querySelector<HTMLTextAreaElement>(
                  "textarea[data-vantage-composer]",
                );
                ta?.focus();
              }, 0);
            }}
            disabled={streaming}
            title={t(team.hintKey)}
            style={{
              cursor: streaming ? "not-allowed" : "pointer",
              border: "1px solid #EDE8DF",
              background: "#FFFFFF",
              borderRadius: 999,
              padding: "6px 11px",
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
              fontSize: 11,
              color: "#5D3000",
              letterSpacing: 0.3,
              transition: "border-color .14s, transform .14s",
              opacity: streaming ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (streaming) return;
              e.currentTarget.style.borderColor = "#5D3000";
              e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "#EDE8DF";
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            {team.slug}
            <span style={{ color: "#A39F99", marginLeft: 6 }}>{t(team.hintKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  input,
  setInput,
  onSubmit,
  onKeyDown,
  streaming,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  streaming: boolean;
}) {
  const t = useTranslations("dock");
  const attachments = useDock((s) => s.attachments);
  const addAttachment = useDock((s) => s.addAttachment);
  const removeAttachment = useDock((s) => s.removeAttachment);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  // Focus state drives the composer's "lift" — deeper shadow + warmer border
  // when the user is actively writing, so the input feels tactile instead of
  // static. Cheap to track; nothing else reads it.
  const [focused, setFocused] = useState(false);

  // Auto-grow textarea — caps at maxHeight via CSS but we still want the
  // box to follow content up to that ceiling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [input]);

  // Track speech recognition lifecycle. We only construct one instance per
  // mount; stopping is idempotent.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* recognition may already be stopped */
      }
    };
  }, []);

  const speechSupported = useMemo(() => getSpeechRecognitionCtor() !== null, []);

  async function handleFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const res = await filesApi.upload(file);
      if (!res.file) {
        setUploadError(t("composer.uploadNoId"));
        return;
      }
      const att: DockAttachment = {
        id: res.file.id,
        name: res.file.filename,
        sizeBytes: res.file.sizeBytes,
        kind: res.kind,
      };
      addAttachment(att);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("composer.uploadFailed");
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  }

  function startListening() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang =
      typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      // Stitch all finalised + interim transcripts into one string and write
      // it back into the composer. Final results survive across `onresult`
      // calls so we don't need to keep our own buffer.
      let transcript = "";
      const results = e.results;
      for (let i = 0; i < results.length; i++) {
        const alt = results[i][0];
        if (alt && typeof alt.transcript === "string") {
          transcript += alt.transcript;
        }
      }
      setInput(transcript.trimStart());
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  function stopListening() {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* noop */
    }
    setListening(false);
  }

  // Mention picker: detect an `@xxx` token at the cursor's left, surface a
  // popover of matching agent teams, and replace the trigger on selection.
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setInput(v);
    const caret = e.target.selectionStart ?? v.length;
    const upto = v.slice(0, caret);
    const m = /(^|\s)@([A-Za-z]*)$/.exec(upto);
    if (m) {
      setMentionOpen(true);
      setMentionQuery(m[2].toLowerCase());
    } else {
      setMentionOpen(false);
    }
  }

  function pickMention(slug: string) {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? input.length;
    const upto = input.slice(0, caret);
    const rest = input.slice(caret);
    const replaced = upto.replace(/(^|\s)@([A-Za-z]*)$/, `$1${slug} `);
    const next = `${replaced}${rest}`;
    setInput(next);
    setMentionOpen(false);
    setTimeout(() => {
      el.focus();
      const pos = replaced.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  const filteredMentions = mentionQuery
    ? AGENT_TEAMS.filter((t) =>
        t.slug.slice(1).toLowerCase().startsWith(mentionQuery),
      )
    : AGENT_TEAMS;

  const sendDisabled =
    streaming || (input.trim().length === 0 && attachments.length === 0);
  // Claude-Code-style mic ⇄ send swap: only one of the two appears on the
  // trailing edge at any time. Treat attachments as "content" too so the
  // user can submit a file-only turn.
  const hasContent = input.trim().length > 0 || attachments.length > 0;

  return (
    <div
      style={{
        flexShrink: 0,
        // No top border — the composer card carries its own shadow so the
        // outer surface stays a quiet background, not a "toolbar shelf".
        padding: "10px 16px 16px",
        background: "#FBF8F3",
        position: "relative",
      }}
    >
      {/* Attachment chips — only render once the user has staged a file. */}
      {(attachments.length > 0 || uploading || uploadError) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {attachments.map((a) => (
            <span
              key={a.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "#FFFFFF",
                border: "1px solid #E8DCCA",
                borderRadius: 8,
                padding: "5px 8px 5px 10px",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
                color: "#2B2822",
                maxWidth: 240,
              }}
              title={`${a.name} · ${formatBytes(a.sizeBytes)}`}
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#5D3000" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.name}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label={t("composer.removeNamed", { name: a.name })}
                title={t("composer.remove")}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "#A39F99",
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
          {uploading && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "#FFFBF4",
                border: "1px dashed #E8DCCA",
                borderRadius: 8,
                padding: "5px 10px",
                fontFamily: "Inter",
                fontSize: 12,
                color: "#5D3000",
              }}
            >
              <Spinner />
              {t("composer.uploading")}
            </span>
          )}
          {uploadError && !uploading && (
            <span
              role="alert"
              style={{
                fontFamily: "Inter",
                fontSize: 11.5,
                color: "#A23A2E",
                padding: "5px 4px",
              }}
            >
              {uploadError}
            </span>
          )}
        </div>
      )}

      {/* Mention popover. Positioned over the composer; closes on selection
          or when the trigger token disappears from the input. */}
      {mentionOpen && filteredMentions.length > 0 && (
        <div
          role="listbox"
          aria-label={t("composer.agentTeamsListLabel")}
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: "calc(100% - 10px)",
            background: "#FFFFFF",
            border: "1px solid #EDE8DF",
            borderRadius: 12,
            boxShadow: "0 14px 32px rgba(40,25,5,.14)",
            padding: 6,
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          <div className="ds-mono-9" style={{ padding: "6px 10px", color: "#A39F99" }}>
            {t("agentTeamsLabel")}
          </div>
          {filteredMentions.map((team) => (
            <button
              key={team.slug}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                // mousedown beats blur so the picker survives the click.
                e.preventDefault();
                pickMention(team.slug);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                background: "transparent",
                border: "none",
                borderRadius: 8,
                padding: "8px 10px",
                textAlign: "left",
                fontFamily: "Inter",
                fontSize: 13.5,
                color: "#2B2822",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#FBF8F3")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace", color: "#5D3000", minWidth: 80 }}>
                {team.slug}
              </span>
              <span style={{ color: "#6B6560", fontSize: 12.5 }}>{t(team.hintKey)}</span>
            </button>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "#FFFFFF",
          // Hairline border carries the resting silhouette; shadow does the
          // "lifted card" work. On focus both warm up together.
          border: focused
            ? "1px solid rgba(93,48,0,.28)"
            : "1px solid rgba(40,25,5,.07)",
          borderRadius: 22,
          padding: "14px 16px 10px",
          boxShadow: focused
            ? "0 1px 2px rgba(40,25,5,.05), 0 12px 36px rgba(40,25,5,.10)"
            : "0 1px 2px rgba(40,25,5,.04), 0 8px 28px rgba(40,25,5,.06)",
          transition: "border-color .18s ease, box-shadow .18s ease",
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // Delay closing the mention popover so a click inside it still lands.
            setTimeout(() => setMentionOpen(false), 120);
          }}
          data-vantage-composer="1"
          // Single calm invitation. Discoverability for attach / @team lives
          // on the icons (tooltip) and the chip groups, not on the placeholder.
          placeholder={t("composer.placeholder")}
          rows={1}
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            resize: "none",
            background: "transparent",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 14.5,
            lineHeight: 1.55,
            color: "#2B2822",
            maxHeight: 160,
            minHeight: 22,
            padding: 0,
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              // Reset so picking the same file twice still triggers onChange.
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          {/* Attach + @ are core actions, surfaced flat. Mic is secondary —
              only appears while empty, and only when the browser supports it,
              so the trailing edge is never crowded next to Send. */}
          <CircleIconButton
            label={t("composer.attachFile")}
            disabled={uploading || streaming}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </CircleIconButton>

          <CircleIconButton
            label={t("composer.mentionTeam")}
            disabled={streaming}
            onClick={() => {
              const el = textareaRef.current;
              if (!el) return;
              const next = `${input}${input.length > 0 && !input.endsWith(" ") ? " " : ""}@`;
              setInput(next);
              setMentionOpen(true);
              setMentionQuery("");
              setTimeout(() => {
                el.focus();
                el.setSelectionRange(next.length, next.length);
              }, 0);
            }}
          >
            <span
              aria-hidden="true"
              style={{
                fontFamily: "JetBrains Mono, ui-monospace, monospace",
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1,
              }}
            >
              @
            </span>
          </CircleIconButton>

          {!hasContent && speechSupported ? (
            <CircleIconButton
              label={listening ? t("composer.stopVoice") : t("composer.voiceInput")}
              disabled={streaming}
              active={listening}
              onClick={() => (listening ? stopListening() : startListening())}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
              </svg>
            </CircleIconButton>
          ) : null}

          <div style={{ flex: 1 }} />

          {/* Hotkey hint earns its place only once there's something to send —
              it becomes the calm acknowledgement that ⌘↵ will fire, paired
              with the live Send button on the trailing edge. */}
          {hasContent && !sendDisabled ? (
            <span
              className="ds-mono-9"
              aria-hidden="true"
              style={{ color: "#A39F99", marginRight: 6 }}
            >
              ⌘↵
            </span>
          ) : null}

          <button
            onClick={onSubmit}
            disabled={sendDisabled}
            style={{
              cursor: sendDisabled ? "not-allowed" : "pointer",
              border: "none",
              // Resting state: low-saturation pebble — present, not noisy.
              // Active state: solid brand brown — the moment "you can send".
              background: sendDisabled ? "#F0E8DA" : "#5D3000",
              width: 32,
              height: 32,
              borderRadius: 999,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition:
                "background .18s ease, transform .18s ease, box-shadow .18s ease",
              boxShadow: sendDisabled
                ? "none"
                : "0 2px 6px rgba(93,48,0,.22)",
            }}
            aria-label={sendDisabled ? t("composer.sendAriaDisabled") : t("composer.sendAria")}
            title={sendDisabled ? t("composer.sendTitleDisabled") : t("composer.sendTitle")}
            onMouseEnter={(e) => {
              if (sendDisabled) return;
              e.currentTarget.style.background = "#7A3F00";
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow =
                "0 4px 10px rgba(93,48,0,.28)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = sendDisabled
                ? "#F0E8DA"
                : "#5D3000";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = sendDisabled
                ? "none"
                : "0 2px 6px rgba(93,48,0,.22)";
            }}
          >
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke={sendDisabled ? "#B8AE9C" : "#FAF8F6"}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: "translateY(-1px)" }}
            >
              {/* Up-arrow — the universally-read "send" glyph, matches Claude. */}
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function CircleIconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      style={{
        cursor: disabled ? "not-allowed" : "pointer",
        background: active ? "#F5EDE3" : "transparent",
        border: "none",
        // 32px hit target = circle, same as Send. Keeps the trailing edge
        // metrically consistent so attach / @ / mic / send all read as
        // siblings, not a mixed toolbar.
        width: 32,
        height: 32,
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: active ? "#5D3000" : disabled ? "#D6CEC0" : "#8C857C",
        transition:
          "background .18s ease, color .18s ease, transform .18s ease",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = active ? "#F0E4D2" : "#F5EFE5";
        e.currentTarget.style.color = "#5D3000";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "#F5EDE3" : "transparent";
        e.currentTarget.style.color = active
          ? "#5D3000"
          : disabled
            ? "#D6CEC0"
            : "#8C857C";
      }}
    >
      {children}
    </button>
  );
}

function iconBtnStyle(): React.CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    width: 28,
    height: 28,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#A39F99",
    transition: "all .14s",
  };
}

function smallIconBtnStyle(): React.CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    width: 24,
    height: 24,
    borderRadius: 7,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#6B6560",
    transition: "all .14s",
  };
}
