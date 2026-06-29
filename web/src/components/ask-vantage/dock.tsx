"use client";

// The Ask Vantage dock — persistent across all workspace routes.
// Modes (vantage-ui-mapping.md §0):
//   closed   floating launcher pill at bottom-right (54px)
//   docked   right-side panel, user-resizable 280–560px
//   full     264px Recent rail + chat surface, overlays whole shell
//
// PR3 rebuild: the conversation body is now <StepTimeline />, fed by the
// AG-UI step store (lib/agent-events). This file keeps only the dock
// *chrome*: header, recent rail, greeting, composer, launcher. The old
// DockMessage rendering (MessageRow / AgentCardRow / ToolTraceRow / etc.)
// is gone — every card lives under components/ask-vantage/cards/.

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  useDock,
  type DockAttachment,
} from "@/lib/ask-vantage-store";
import {
  sendAsk,
  useIsStreaming,
  useHasSteps,
  useAgentStream,
} from "@/lib/agent-events";
import { useVantage } from "@/lib/store";
import { files as filesApi } from "@/lib/api";
import { greetingFor } from "@/lib/dates";
import { StepTimeline } from "./step-timeline";

// A single chip carries two strings: `display` is the short English line on
// the card; `prompt` is the verbose instruction we actually send to the
// coordinator. Splitting them keeps the cards scannable without dumbing down
// the prompt the LLM gets.
interface SuggestionChip {
  displayKey: string;
  prompt: string;
}

interface SuggestionGroup {
  id: "this_resume" | "explore";
  labelKey: string;
  scopeHintKey?: string;
}

// Explore group — global tracks you'd ask Vantage from any page.
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

// "This résumé" group. Each chip's `prompt` is the original verbose
// instruction (carrying the no-fabrication red line — vision.md §"诚实是底线");
// `display` is the action-style short line the user sees.
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
// the coordinator side (agent-architecture.md §2).
const AGENT_TEAMS: { slug: string; label: string; hintKey: string }[] = [
  { slug: "@scout", label: "Scout", hintKey: "agentTeams.scout" },
  { slug: "@resume", label: "Résumé", hintKey: "agentTeams.resume" },
  { slug: "@interview", label: "Interview", hintKey: "agentTeams.interview" },
  { slug: "@apply", label: "Application", hintKey: "agentTeams.apply" },
  { slug: "@trend", label: "Trend", hintKey: "agentTeams.trend" },
];

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

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
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

// Relative-time formatter for the RECENT rail.
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
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// RecentRail — the dock's history strip in "full" layout. Anchors-only
// model (vantage-ui-mapping §1.2): each row is a past user prompt; click
// scrolls the timeline back to that turn.
function RecentRail({ scrollRoot }: { scrollRoot: React.RefObject<HTMLDivElement | null> }) {
  const t = useTranslations("dock");
  const anchors = useDock((s) => s.recentAnchors);
  const [pulseId, setPulseId] = useState<string | null>(null);

  const scrollToAnchor = (id: string) => {
    const root = scrollRoot.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!target) {
      setPulseId(`miss:${id}`);
      window.setTimeout(() => setPulseId(null), 800);
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setPulseId(id);
    window.setTimeout(() => setPulseId(null), 1400);
  };

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
            <div className="ds-mono-9" style={{ marginTop: 1, color: isMiss ? "#A23A2E" : "#A39F99" }}>
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
  const input = useDock((s) => s.input);
  const setInput = useDock((s) => s.setInput);
  const toggleFull = useDock((s) => s.toggleFull);
  const toggleDock = useDock((s) => s.toggleDock);
  const hintedCollapse = useDock((s) => s.hintedCollapse);
  const attachments = useDock((s) => s.attachments);

  // Live conversation state now lives in the agent-events store.
  const streaming = useIsStreaming();
  const hasSteps = useHasSteps();

  const pathname = usePathname();
  const chipGroups = useMemo(() => chipGroupsForPath(pathname), [pathname]);

  const currentUser = useVantage((s) => s.currentUser);
  const currentResumeId = useVantage((s) => s.currentResumeId);
  const parsedResume = useVantage((s) => s.parsedResume);
  const parseJobStatus = useVantage((s) => s.parseJobStatus);

  const firstName = useMemo(() => {
    const resumeName = parsedResume?.basics?.name?.trim() ?? "";
    const auth = currentUser?.displayName?.trim() ?? "";
    const source = resumeName || auth;
    return source.split(/\s+/)[0] ?? "";
  }, [parsedResume, currentUser]);

  // Surface + thread override for "This résumé" chips. Sending a scoped chip
  // swaps the conversation onto the resume_studio thread so the resume_agent
  // has the right per-branch checkpointer history.
  const resumeStudioThread = useMemo(() => {
    if (!currentUser || !currentResumeId) return null;
    return `resume_studio:${currentUser.id}:${currentResumeId}`;
  }, [currentUser, currentResumeId]);

  const dragging = useRef<{ startX: number; startW: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hintedCollapse && state === "docked") {
      useDock.setState({ state: "closed" });
    }
  }, [hintedCollapse, state]);

  // Reset the live timeline when the effective thread changes (lifetime
  // ask_vantage vs a per-résumé resume_studio thread) so each thread starts
  // visually clean. recentAnchors live on the dock store and survive.
  const effectiveThread = useMemo(() => {
    return pathname?.startsWith("/app/studio/resume") && resumeStudioThread
      ? resumeStudioThread
      : "ask_vantage";
  }, [pathname, resumeStudioThread]);
  const prevEffectiveThread = useRef<string>(effectiveThread);
  useEffect(() => {
    if (prevEffectiveThread.current !== effectiveThread) {
      prevEffectiveThread.current = effectiveThread;
      useAgentStream.getState().reset();
    }
  }, [effectiveThread]);

  // Unmount-time stream cleanup. The dock is re-mounted by AppLayout on every
  // overlay flip; without this an in-flight SSE reader keeps pulling bytes
  // after the React tree is gone.
  useEffect(() => {
    return () => {
      const dock = useDock.getState();
      if (dock.streaming || dock.abortController) dock.cancelStream();
    };
  }, []);

  // Auto-scroll to bottom as steps stream in.
  const stepCount = useAgentStream((s) => s.order.length);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [stepCount, streaming]);

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
    // Reject a 1-char body with no attachments — used to burn a whole turn.
    if (text && text.length < 2 && attachments.length === 0) return;
    const finalPrompt = text || t("reviewAttachments");
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
          boxShadow: "0 1px 2px rgba(40,25,5,.05), 0 12px 32px rgba(40,25,5,.10)",
          cursor: "pointer",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          transition: "background .18s ease, transform .18s ease, box-shadow .18s ease, border-color .18s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "#FFFFFF";
          e.currentTarget.style.transform = "translateY(-1px)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "#FAF8F6";
          e.currentTarget.style.transform = "translateY(0)";
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
                onClick={() => useAgentStream.getState().reset()}
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
            {!hasSteps ? (
              <Greeting
                firstName={firstName}
                streaming={streaming}
                chipGroups={chipGroups}
                resumeStudioThread={resumeStudioThread}
                parseJobStatus={parseJobStatus}
              />
            ) : (
              <StepTimeline scrollRef={scrollRef} />
            )}
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
  resumeStudioThread: string | null;
  parseJobStatus: "idle" | "running" | "done" | "failed";
}) {
  const t = useTranslations("dock");
  const today = useMemo(() => {
    const d = new Date();
    return d
      .toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" })
      .toUpperCase();
  }, []);
  const greeting = useMemo(() => {
    const g = greetingFor();
    const key =
      g === "Good morning" ? "morning" : g === "Good afternoon" ? "afternoon" : "evening";
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
        const scopedDisabled = isScoped && resumeStudioThread == null;
        return (
          <div key={group.meta.id} style={{ marginTop: gi === 0 ? 0 : 22 }}>
            {chipGroups.length > 1 ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 10 }}>
                <span className="ds-mono-10" style={{ color: "#5D3000" }}>
                  {t(group.meta.labelKey).toUpperCase()}
                </span>
                {group.meta.scopeHintKey ? (
                  <span style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 11.5, color: "#A39F99" }}>
                    {t(group.meta.scopeHintKey)}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {group.chips.map((chip) => {
                const chipDisabled = streaming || scopedDisabled;
                const sendOpts =
                  isScoped && resumeStudioThread
                    ? { surface: "resume_studio" as const, threadIdOverride: resumeStudioThread }
                    : undefined;
                const chipDisplay = t(chip.displayKey);
                return (
                  <button
                    key={`${group.meta.id}:${chip.displayKey}`}
                    onClick={() => {
                      if (chipDisabled) return;
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
              useDock.getState().setInput(`${team.slug} `);
              setTimeout(() => {
                const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-vantage-composer]");
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
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [input]);

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
    rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let transcript = "";
      const results = e.results;
      for (let i = 0; i < results.length; i++) {
        const alt = results[i][0];
        if (alt && typeof alt.transcript === "string") transcript += alt.transcript;
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
    ? AGENT_TEAMS.filter((tm) => tm.slug.slice(1).toLowerCase().startsWith(mentionQuery))
    : AGENT_TEAMS;

  const sendDisabled = streaming || (input.trim().length === 0 && attachments.length === 0);
  const hasContent = input.trim().length > 0 || attachments.length > 0;

  return (
    <div style={{ flexShrink: 0, padding: "10px 16px 16px", background: "#FBF8F3", position: "relative" }}>
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
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "#A39F99", padding: 0, display: "inline-flex", alignItems: "center" }}
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
            <span role="alert" style={{ fontFamily: "Inter", fontSize: 11.5, color: "#A23A2E", padding: "5px 4px" }}>
              {uploadError}
            </span>
          )}
        </div>
      )}

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
          border: focused ? "1px solid rgba(93,48,0,.28)" : "1px solid rgba(40,25,5,.07)",
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
            setTimeout(() => setMentionOpen(false), 120);
          }}
          data-vantage-composer="1"
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
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
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
            <span aria-hidden="true" style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 13, fontWeight: 500, lineHeight: 1 }}>
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

          {hasContent && !sendDisabled ? (
            <span className="ds-mono-9" aria-hidden="true" style={{ color: "#A39F99", marginRight: 6 }}>
              ⌘↵
            </span>
          ) : null}

          <button
            onClick={onSubmit}
            disabled={sendDisabled}
            style={{
              cursor: sendDisabled ? "not-allowed" : "pointer",
              border: "none",
              background: sendDisabled ? "#F0E8DA" : "#5D3000",
              width: 32,
              height: 32,
              borderRadius: 999,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "background .18s ease, transform .18s ease, box-shadow .18s ease",
              boxShadow: sendDisabled ? "none" : "0 2px 6px rgba(93,48,0,.22)",
            }}
            aria-label={sendDisabled ? t("composer.sendAriaDisabled") : t("composer.sendAria")}
            title={sendDisabled ? t("composer.sendTitleDisabled") : t("composer.sendTitle")}
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
        width: 32,
        height: 32,
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: active ? "#5D3000" : disabled ? "#D6CEC0" : "#8C857C",
        transition: "background .18s ease, color .18s ease, transform .18s ease",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = active ? "#F0E4D2" : "#F5EFE5";
        e.currentTarget.style.color = "#5D3000";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "#F5EDE3" : "transparent";
        e.currentTarget.style.color = active ? "#5D3000" : disabled ? "#D6CEC0" : "#8C857C";
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
