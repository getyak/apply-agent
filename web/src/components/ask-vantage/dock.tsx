"use client";

// The Ask Vantage dock — persistent across all workspace routes.
// Modes from Vantage.dc.html (lines 818–976):
//   closed   floating launcher pill at bottom-right
//   docked   right-side panel, user-resizable 280–560px
//   full     264px Recent rail + chat surface, overlays whole shell
//
// Mock-live sets hintedCollapse → we auto-collapse to launcher per
// docs/architecture/vantage-ui-mapping.md §3.6.

import { useEffect, useMemo, useRef } from "react";
import { useDock, type DockMessage } from "@/lib/ask-vantage-store";
import { sendAsk } from "@/lib/ask-stream";
import { useVantage } from "@/lib/store";

const SUGGESTIONS = [
  "Find roles I should look at today",
  "Sharpen my résumé for Stripe",
  "Practise the Stripe recruiter screen",
  "What changed in the market this week?",
  "Build me a cover letter for Linear",
] as const;

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
  if (!ev) return null;
  const statusColor =
    ev.state === "done"
      ? "#4C7A3F"
      : ev.state === "failed"
        ? "#A23A2E"
        : "#A66A00";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "#FFFFFF",
        border: "1px solid #E8DCCA",
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
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

  const currentUser = useVantage((s) => s.currentUser);
  const firstName = useMemo(() => {
    const n = currentUser?.displayName ?? "";
    const first = n.split(/\s+/)[0] ?? "";
    return first || "there";
  }, [currentUser]);

  const dragging = useRef<{ startX: number; startW: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hintedCollapse && state === "docked") {
      useDock.setState({ state: "closed" });
    }
  }, [hintedCollapse, state]);

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
    if (!text || streaming) return;
    void sendAsk(text);
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
            {!hasLog && <Greeting firstName={firstName} onPick={(p) => useDock.getState().setInput(p)} />}
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
  onPick,
}: {
  firstName: string;
  onPick: (s: string) => void;
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
        What should we work on? Ask anything, or pick a place to start.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {SUGGESTIONS.map((sug) => (
          <button
            key={sug}
            onClick={() => onPick(sug)}
            className="ds-card"
            style={{
              cursor: "pointer",
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: 11,
              transition: "border-color .15s",
              textAlign: "left",
              width: "100%",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#5D3000")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#EDE8DF")}
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
  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: "1px solid #EDE8DF",
        padding: "12px 16px 16px",
        background: "#FBF8F3",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 9,
          background: "#FFFFFF",
          border: "1px solid #D6CEC0",
          borderRadius: 12,
          padding: "8px 6px 8px 14px",
          boxShadow: "0 1px 2px rgba(0,0,0,.04)",
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything, or launch a task…"
          rows={1}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            resize: "none",
            background: "transparent",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 13.5,
            lineHeight: 1.5,
            color: "#2B2822",
            maxHeight: 140,
            minHeight: 22,
            padding: "4px 0",
          }}
        />
        <button
          onClick={onSubmit}
          disabled={streaming || input.trim().length === 0}
          style={{
            cursor: streaming || input.trim().length === 0 ? "not-allowed" : "pointer",
            border: "none",
            background: streaming || input.trim().length === 0 ? "#D6CEC0" : "#5D3000",
            width: 34,
            height: 34,
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            transition: "background .14s",
          }}
          aria-label="Send"
          title="Send (⌘↵)"
        >
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
          </svg>
        </button>
      </div>
      <div className="ds-mono-9" style={{ marginTop: 6, textAlign: "right", color: "#A39F99" }}>
        ⌘↵ TO SEND
      </div>
    </div>
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
