// Vibe chat panel — left rail of the Resume Studio (and the seed for the
// other per-document panels described in vantage-ui-mapping.md §2.6).
//
// Owns rendering only. State + send live in useConversationStream (see
// web/src/lib/use-conversation-stream.ts). The host passes in the hook's
// outputs plus the 4 recommendation chips that prime the conversation
// (优化建议 / JD 微调 / 职业规划 / 职业推荐).

"use client";

import { useEffect, useRef } from "react";
import {
  type AgentEvent,
  type DockMessage,
} from "@/lib/ask-vantage-store";

// Local palette — matches the dock's warm-paper system so the two panels
// look like cousins, not strangers. We don't import from globals.css
// because that file is in flux and the panel needs to stay legible
// independent of token churn.
const P = {
  paper: "#FAF8F6",
  surface: "#FFFFFF",
  surfaceAlt: "#FBF8F3",
  ink: "#2B2822",
  body: "#5d564f",
  muted: "#9A938A",
  border: "#EAE3D6",
  borderStrong: "#D6CEC0",
  accent: "#5D3000",
  accentSoft: "#F5EDE3",
  cta: "#1F1B17",
  ctaInk: "#FAF8F6",
} as const;

export interface VibeChip {
  id: string;
  label: string;
  hint: string;
  // When the chip is clicked, the host decides what to do — usually it
  // prepares an active prompt and calls send(). We don't bake the chip
  // → prompt mapping in here because some chips need surface state
  // (e.g. JD 微调 needs the JD textarea value).
  onActivate: () => void;
  // Disabled chips render dimmed and ignore clicks. Used while a stream
  // is in flight so a click can't kick off a second concurrent turn.
  disabled?: boolean;
}

export interface VibeChatPanelProps {
  title: string;
  subtitle: string;
  chips: VibeChip[];
  messages: DockMessage[];
  agentEvents: Record<string, AgentEvent>;
  streaming: boolean;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  // The host controls width — the studio renders the panel inside a
  // resizable column. Defaults to 380 px to match §2.1.
  width?: number;
}

export function VibeChatPanel({
  title,
  subtitle,
  chips,
  messages,
  agentEvents,
  streaming,
  input,
  onInputChange,
  onSend,
  onCancel,
  width = 380,
}: VibeChatPanelProps) {
  // Auto-scroll the message list to the bottom whenever a new message
  // arrives or the streaming assistant bubble grows. The user can scroll
  // up and we won't fight them — only sticky-to-bottom when the latest
  // tail was already visible.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = dist < 40;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘↵ or Ctrl↵ sends. Plain Enter inserts a newline so multi-line
    // résumé-edit asks ("rewrite this bullet, but keep the metric") are
    // natural to type.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <aside
      style={{
        width,
        flexShrink: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: P.surfaceAlt,
        borderRight: `1px solid ${P.border}`,
      }}
    >
      {/* Header — name what this panel is and what scope it covers. */}
      <div
        style={{
          padding: "20px 22px 16px",
          borderBottom: `1px solid ${P.border}`,
          background: P.surface,
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 10.5,
            letterSpacing: 1,
            color: P.muted,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Vibe chat
        </div>
        <div
          style={{
            fontFamily: "Inter",
            fontWeight: 600,
            fontSize: 16,
            color: P.ink,
            lineHeight: 1.3,
            marginBottom: 4,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: "Inter",
            fontSize: 12.5,
            color: P.body,
            lineHeight: 1.45,
          }}
        >
          {subtitle}
        </div>
      </div>

      {/* Chips — "starting points" for the conversation. Always visible so
          the user can launch a different track mid-conversation. */}
      {chips.length > 0 ? (
        <div
          style={{
            padding: "14px 18px 8px",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            borderBottom: `1px solid ${P.border}`,
          }}
        >
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={chip.onActivate}
              disabled={chip.disabled}
              title={chip.hint}
              style={chipStyle(chip.disabled)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* Message stream. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "18px 18px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              fontFamily: "Inter",
              fontSize: 13,
              lineHeight: 1.55,
              color: P.muted,
              padding: "18px 4px",
            }}
          >
            Ask Vantage to sharpen a bullet, tailor this résumé for a JD, or
            map the next step in your career. Anything you say here stays
            scoped to this résumé.
          </div>
        ) : (
          messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              agentEvents={agentEvents}
            />
          ))
        )}
        {streaming ? <Thinking /> : null}
      </div>

      {/* Composer. */}
      <div
        style={{
          padding: "12px 14px 14px",
          borderTop: `1px solid ${P.border}`,
          background: P.surface,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            background: P.surface,
            border: `1px solid ${P.borderStrong}`,
            borderRadius: 10,
            padding: "8px 10px",
          }}
        >
          <textarea
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Tighten this bullet · Tailor for a JD · …  (⌘↵ send)"
            rows={2}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              resize: "none",
              fontFamily: "Inter",
              fontSize: 13,
              lineHeight: 1.55,
              color: P.ink,
              background: "transparent",
              padding: "4px 2px",
              minHeight: 36,
              maxHeight: 180,
            }}
          />
          {streaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop"
              style={iconBtnGhost()}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <rect x={6} y={6} width={12} height={12} rx={1.5} />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              aria-label="Send"
              style={sendBtnStyle(!input.trim())}
              disabled={!input.trim()}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={P.ctaInk} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── Message rendering ─────────────────────────────────────────────────

function MessageRow({
  message,
  agentEvents,
}: {
  message: DockMessage;
  agentEvents: Record<string, AgentEvent>;
}) {
  switch (message.kind) {
    case "user":
      return <UserBubble text={message.text ?? ""} />;
    case "assistant":
      return <AssistantBubble text={message.text ?? ""} />;
    case "agents":
      return (
        <AgentGroup
          ids={message.agents ?? []}
          events={agentEvents}
        />
      );
    case "result":
      return (
        <ResultCard
          title={message.title ?? ""}
          sub={message.sub ?? ""}
          action={message.action ?? ""}
          onAction={message.onAction}
        />
      );
    default:
      return null;
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div
        style={{
          maxWidth: "85%",
          background: P.ink,
          color: P.ctaInk,
          borderRadius: 12,
          padding: "8px 12px",
          fontFamily: "Inter",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({ text }: { text: string }) {
  // Empty assistant bubble = the turn just started; the Thinking indicator
  // at the bottom of the list covers that state, so we don't render an
  // empty pill that flickers in and out.
  if (!text) return null;
  return (
    <div
      style={{
        background: P.surface,
        border: `1px solid ${P.border}`,
        borderRadius: 12,
        padding: "10px 13px",
        fontFamily: "Inter",
        fontSize: 13.5,
        lineHeight: 1.55,
        color: P.ink,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </div>
  );
}

function AgentGroup({
  ids,
  events,
}: {
  ids: string[];
  events: Record<string, AgentEvent>;
}) {
  if (ids.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: P.accentSoft,
        border: `1px solid ${P.border}`,
        borderRadius: 10,
        padding: "8px 10px",
      }}
    >
      {ids.map((id) => {
        const ev = events[id];
        if (!ev) return null;
        return <AgentRow key={id} event={ev} />;
      })}
    </div>
  );
}

function AgentRow({ event }: { event: AgentEvent }) {
  const dotColor =
    event.state === "running"
      ? P.accent
      : event.state === "done"
        ? "#4C7A3F"
        : "#A23A2E";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: "JetBrains Mono",
          fontSize: 10.5,
          letterSpacing: 0.5,
          color: P.body,
          textTransform: "uppercase",
        }}
      >
        {event.label}
      </span>
      <span
        style={{
          marginLeft: "auto",
          fontFamily: "JetBrains Mono",
          fontSize: 10,
          color: P.muted,
          textTransform: "uppercase",
        }}
      >
        {event.statusText}
      </span>
    </div>
  );
}

function ResultCard({
  title,
  sub,
  action,
  onAction,
}: {
  title: string;
  sub: string;
  action: string;
  onAction?: () => void;
}) {
  return (
    <div
      style={{
        background: P.surface,
        border: `1px solid ${P.borderStrong}`,
        borderRadius: 12,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: P.ink }}>
        {title}
      </div>
      {sub ? (
        <div style={{ fontFamily: "Inter", fontSize: 12.5, color: P.body, lineHeight: 1.5 }}>
          {sub}
        </div>
      ) : null}
      {action && onAction ? (
        <button
          type="button"
          onClick={onAction}
          style={{
            alignSelf: "flex-start",
            marginTop: 6,
            background: P.cta,
            color: P.ctaInk,
            border: "none",
            borderRadius: 8,
            padding: "6px 12px",
            fontFamily: "Inter",
            fontSize: 12.5,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}

function Thinking() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={dotStyle(0)} />
      <span style={dotStyle(120)} />
      <span style={dotStyle(240)} />
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────

function chipStyle(disabled: boolean | undefined): React.CSSProperties {
  return {
    cursor: disabled ? "default" : "pointer",
    background: disabled ? P.surfaceAlt : P.surface,
    color: disabled ? P.muted : P.ink,
    border: `1px solid ${P.border}`,
    borderRadius: 999,
    padding: "5px 11px",
    fontFamily: "Inter",
    fontSize: 12,
    fontWeight: 500,
    opacity: disabled ? 0.6 : 1,
  };
}

function sendBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    cursor: disabled ? "default" : "pointer",
    background: disabled ? P.muted : P.cta,
    border: "none",
    width: 30,
    height: 30,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    opacity: disabled ? 0.55 : 1,
  };
}

function iconBtnGhost(): React.CSSProperties {
  return {
    cursor: "pointer",
    background: "transparent",
    border: `1px solid ${P.borderStrong}`,
    color: P.ink,
    width: 30,
    height: 30,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

function dotStyle(delayMs: number): React.CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: P.muted,
    // Reuse the existing pulse-dot keyframes defined in globals.css.
    animation: `pulse-dot 1.2s ease-in-out ${delayMs}ms infinite`,
    display: "inline-block",
  };
}
