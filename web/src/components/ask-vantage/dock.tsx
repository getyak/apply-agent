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
import { usePathname } from "next/navigation";
import {
  useDock,
  type DockAttachment,
  type DockMessage,
} from "@/lib/ask-vantage-store";
import { sendAsk } from "@/lib/ask-stream";
import { useVantage } from "@/lib/store";
import { files as filesApi } from "@/lib/api";

// Cross-surface chips: things you'd ask Vantage no matter which page you're
// on. The default set — used everywhere except Resume Studio, where the
// document-scoped vibe panel already owns résumé chips (see
// docs/architecture/vantage-ui-mapping.md §2.6).
const SUGGESTIONS_DEFAULT = [
  "Find roles I should look at today",
  "Sharpen my résumé for Stripe",
  "Practise the Stripe recruiter screen",
  "What changed in the market this week?",
  "Build me a cover letter for Linear",
] as const;

// Resume Studio variant: the studio's left vibe panel owns "sharpen this
// résumé / tailor for a JD" — the dock here surfaces other tracks the
// user might still want without leaving the page.
const SUGGESTIONS_RESUME_STUDIO = [
  "Find roles I should look at today",
  "Practise the Stripe recruiter screen",
  "What changed in the market this week?",
  "Build me a cover letter for Linear",
] as const;

function suggestionsForPath(pathname: string | null): readonly string[] {
  if (pathname?.startsWith("/app/studio/resume")) {
    return SUGGESTIONS_RESUME_STUDIO;
  }
  return SUGGESTIONS_DEFAULT;
}

// Agent teams surfaced via "@" mentions — each is a LangGraph node name on
// the coordinator side (see docs/architecture/agent-architecture.md §2).
const AGENT_TEAMS: { slug: string; label: string; hint: string }[] = [
  { slug: "@scout", label: "Scout", hint: "Find / match roles" },
  { slug: "@resume", label: "Résumé", hint: "Parse · optimise · tailor" },
  { slug: "@interview", label: "Interview", hint: "Mock · feedback" },
  { slug: "@apply", label: "Application", hint: "Cover letters · form prep" },
  { slug: "@trend", label: "Trend", hint: "Market · skills movement" },
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

function ThinkingDots() {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {[0, 0.15, 0.3].map((d) => (
        <span
          key={d}
          className="animate-bob"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "#D6CEC0",
            animationDelay: `${d}s`,
          }}
        />
      ))}
    </div>
  );
}

function AgentCardRow({ id }: { id: string }) {
  const ev = useDock((s) => s.agentEvents[id]);
  // Auto-expand while the agent is still thinking; collapse once it's done so
  // a long history of finished steps doesn't dominate the scroll.
  const [open, setOpen] = useState(ev?.state === "running");
  useEffect(() => {
    if (ev?.state === "running") setOpen(true);
  }, [ev?.state]);
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
        aria-label={open ? "Collapse thinking" : "Expand thinking"}
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
          style={{ marginLeft: "auto", color: statusColor }}
        >
          {ev.statusText}
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
            agent · <span style={{ color: "#5D3000" }}>{ev.agent}</span>
          </div>
          <div className="ds-mono-9" style={{ color: "#A39F99" }}>
            started · <span style={{ color: "#5D3000" }}>{startedAt}</span>
          </div>
          <div className="ds-mono-9" style={{ color: "#A39F99" }}>
            status · <span style={{ color: statusColor }}>{ev.state}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MessageRow({ m }: { m: DockMessage }) {
  if (m.kind === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
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
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 13.5,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            minWidth: 0,
            flex: 1,
          }}
        >
          {m.text || "…"}
        </div>
      </div>
    );
  }

  if (m.kind === "agents") {
    if (!m.agents || m.agents.length === 0) return null;
    return (
      <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
        <div style={{ width: 28, flexShrink: 0 }} />
        <div
          style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}
        >
          {m.agents.map((id) => (
            <AgentCardRow key={id} id={id} />
          ))}
        </div>
      </div>
    );
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
              <div style={{ fontFamily: "Inter", fontSize: 12.5, color: "#6B6560", marginTop: 2 }}>
                {m.sub}
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

  return null;
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

export function AskVantageDock() {
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

  // Pathname picks the suggestion set per §2.6: Resume Studio routes drop
  // the "Sharpen my résumé" chip because the studio's own vibe panel owns
  // that track.
  const pathname = usePathname();
  const suggestions = useMemo(() => suggestionsForPath(pathname), [pathname]);

  const currentUser = useVantage((s) => s.currentUser);
  const firstName = useMemo(() => {
    const n = currentUser?.displayName ?? "";
    const first = n.split(/\s+/)[0] ?? "";
    return first || "there";
  }, [currentUser]);

  const attachments = useDock((s) => s.attachments);

  const dragging = useRef<{ startX: number; startW: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hintedCollapse && state === "docked") {
      useDock.setState({ state: "closed" });
    }
  }, [hintedCollapse, state]);

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
    const finalPrompt = text || "Please review the attached file(s).";
    void sendAsk(finalPrompt, attachments);
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
        title="Open Ask Vantage"
        style={{
          position: "fixed",
          bottom: 26,
          right: 26,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: "#5D3000",
          color: "#FAF8F6",
          border: "none",
          borderRadius: 999,
          padding: "13px 19px 13px 15px",
          boxShadow: "0 10px 30px rgba(40,25,5,.30)",
          cursor: "pointer",
          fontFamily: "Inter, system-ui, sans-serif",
          fontWeight: 600,
          fontSize: 14,
          transition: "background .16s, transform .16s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "#7A3F00";
          e.currentTarget.style.transform = "translateY(-1px)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "#5D3000";
          e.currentTarget.style.transform = "translateY(0)";
        }}
      >
        <VantageMark size={18} />
        Ask Vantage
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
          title="Drag to resize"
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
            Ask Vantage
          </div>
          <div className="ds-mono-9">YOUR AGENT · ALWAYS HERE</div>
        </div>
        <button
          onClick={toggleFull}
          title={isFull ? "Dock" : "Expand"}
          style={iconBtnStyle()}
          aria-label={isFull ? "Dock" : "Expand"}
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
          title="Collapse"
          style={iconBtnStyle()}
          aria-label="Collapse"
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
              <span className="ds-label" style={{ color: "#6B6560" }}>RECENT</span>
              <button
                onClick={() => useDock.getState().reset()}
                title="New chat"
                style={smallIconBtnStyle()}
                aria-label="New chat"
              >
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <div className="ds-caption" style={{ padding: "12px 8px", color: "#A39F99" }}>
              Your conversation lives here. Open it again from any tab.
            </div>
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
                suggestions={suggestions}
              />
            )}
            {messages.map((m) => (
              <MessageRow key={m.id} m={m} />
            ))}
            {streaming && (
              <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
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
                <ThinkingDots />
              </div>
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
  suggestions,
}: {
  firstName: string;
  streaming: boolean;
  suggestions: readonly string[];
}) {
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
  return (
    <div className="animate-fade-up">
      <div className="ds-mono-10" style={{ marginBottom: 10 }}>TODAY · {today}</div>
      <h1 className="ds-h2" style={{ margin: "0 0 7px", color: "#2B2822" }}>
        Good morning, {firstName}.
      </h1>
      <p className="ds-body-sm" style={{ color: "#6B6560", margin: "0 0 20px" }}>
        What should we work on? Tap a card to send it instantly — or write your
        own.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {suggestions.map((sug) => (
          <button
            key={sug}
            onClick={() => {
              if (streaming) return;
              // Quick-prompt chips bypass the composer and fire straight at
              // the coordinator — per current UX, the chip IS the action,
              // not a draft seed.
              void sendAsk(sug);
            }}
            disabled={streaming}
            className="ds-card"
            style={{
              cursor: streaming ? "not-allowed" : "pointer",
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: 11,
              transition: "border-color .15s, transform .15s",
              textAlign: "left",
              width: "100%",
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
              {sug}
            </span>
          </button>
        ))}
      </div>

      <div className="ds-mono-10" style={{ margin: "28px 0 10px", color: "#A39F99" }}>
        AGENT TEAMS
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
            title={team.hint}
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
            <span style={{ color: "#A39F99", marginLeft: 6 }}>{team.hint}</span>
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
        setUploadError("Upload accepted but no file id returned.");
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
      const msg = err instanceof Error ? err.message : "Upload failed";
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
        borderTop: "1px solid #EDE8DF",
        padding: "12px 16px 16px",
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
                aria-label={`Remove ${a.name}`}
                title="Remove"
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
              Uploading…
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
          aria-label="Agent teams"
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
            AGENT TEAMS
          </div>
          {filteredMentions.map((t) => (
            <button
              key={t.slug}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                // mousedown beats blur so the picker survives the click.
                e.preventDefault();
                pickMention(t.slug);
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
                {t.slug}
              </span>
              <span style={{ color: "#6B6560", fontSize: 12.5 }}>{t.hint}</span>
            </button>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: "#FFFFFF",
          border: "1px solid #E0D6C5",
          borderRadius: 16,
          padding: "10px 12px 8px",
          boxShadow:
            "0 1px 2px rgba(40,25,5,.04), 0 8px 24px rgba(40,25,5,.05)",
          transition: "border-color .14s, box-shadow .14s",
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMentionOpen(false), 120)}
          data-vantage-composer="1"
          placeholder="Ask anything, attach a résumé, or @team to delegate…"
          rows={1}
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            resize: "none",
            background: "transparent",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 14,
            lineHeight: 1.5,
            color: "#2B2822",
            maxHeight: 140,
            minHeight: 24,
            padding: 0,
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
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
          <CircleIconButton
            label="Attach file"
            disabled={uploading || streaming}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </CircleIconButton>

          {/* Mic ⇄ Send swap (Claude-Code-style): when the textarea is empty,
              show the mic; once the user starts typing or attaches a file,
              hide the mic and show send. Keeps the trailing edge calm. */}
          {!hasContent ? (
            <CircleIconButton
              label={
                !speechSupported
                  ? "Voice input unsupported in this browser"
                  : listening
                    ? "Stop voice input"
                    : "Start voice input"
              }
              disabled={!speechSupported || streaming}
              active={listening}
              onClick={() => (listening ? stopListening() : startListening())}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
              </svg>
            </CircleIconButton>
          ) : null}

          <CircleIconButton
            label="Mention agent team"
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
            <span style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 13 }}>
              @
            </span>
          </CircleIconButton>

          <div style={{ flex: 1 }} />

          <span className="ds-mono-9" style={{ color: "#A39F99" }}>
            ⌘↵ SEND
          </span>

          {hasContent ? (
            <button
              onClick={onSubmit}
              disabled={sendDisabled}
              style={{
                cursor: sendDisabled ? "not-allowed" : "pointer",
                border: "none",
                background: sendDisabled ? "#E0D6C5" : "#5D3000",
                width: 34,
                height: 34,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                transition: "background .14s, transform .14s",
              }}
              aria-label="Send"
              title="Send (⌘↵)"
              onMouseEnter={(e) => {
                if (sendDisabled) return;
                e.currentTarget.style.background = "#7A3F00";
                e.currentTarget.style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = sendDisabled ? "#E0D6C5" : "#5D3000";
                e.currentTarget.style.transform = "translateY(0)";
              }}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
              </svg>
            </button>
          ) : null}
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
        width: 30,
        height: 30,
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: active ? "#5D3000" : disabled ? "#D6CEC0" : "#6B6560",
        transition: "background .14s, color .14s",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = active ? "#F0E4D2" : "#FBF8F3";
        e.currentTarget.style.color = "#5D3000";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "#F5EDE3" : "transparent";
        e.currentTarget.style.color = active
          ? "#5D3000"
          : disabled
            ? "#D6CEC0"
            : "#6B6560";
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
