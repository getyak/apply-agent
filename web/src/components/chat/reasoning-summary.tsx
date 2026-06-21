// ReasoningSummary — outer collapse over the per-turn agent task cards.
//
// docs/architecture/vantage-ui-mapping.md §1.4 maps each LangGraph node
// onto a task card (AgentCardRow). When a turn touches several agents in
// sequence, the dock can quickly fill with 4-5 cards plus their own
// internal collapses. ReasoningSummary wraps that pile into a single
// "Thinking · N.Ns · k steps" header that mirrors the Claude Code
// thinking-block UX: the user sees the gist at a glance and can drill
// down only when they want to.
//
// State derivation: this component is purely a view over the
// AgentEvent[] the caller hands it. The caller is responsible for
// looking up the records from whichever pool owns them (today: useDock;
// future per-surface stores) so we don't couple chat rendering to a
// particular store.

"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import type { AgentEvent } from "@/lib/ask-vantage-store";

import "./markdown.css";

interface ReasoningSummaryProps {
  // Resolved AgentEvent records, in start order. Missing ids should be
  // filtered out by the caller (they'd indicate a stale message id).
  events: AgentEvent[];
  // Inner rendering — the caller knows how to render an AgentCardRow
  // bound to its own store. We just provide the surrounding collapse
  // + header.
  children: ReactNode;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

export function ReasoningSummary({ events, children }: ReasoningSummaryProps) {
  const running = events.some((e) => e.state === "running");
  const failed = events.some((e) => e.state === "failed");
  const stepCount = events.length;

  const earliestStart = useMemo(
    () => (events.length ? Math.min(...events.map((e) => e.ts)) : 0),
    [events],
  );

  // Live duration: while any agent is still running we tick from the
  // earliest start; once everything settles we freeze on the last
  // tick value so the header stays stable when collapsed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);

  const durationMs = earliestStart ? Math.max(0, now - earliestStart) : 0;
  const durationLabel = formatDuration(durationMs);

  // Open while running so the user can watch progress; auto-collapse
  // on completion so a long chat doesn't drown in old thinking. User
  // can re-open by clicking the header. We "adjust state during render"
  // by stashing the *previous* `running` value in state alongside
  // `open` and comparing — see React docs:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [open, setOpen] = useState<boolean>(true);
  const [prevRunning, setPrevRunning] = useState<boolean>(running);
  if (prevRunning !== running) {
    setPrevRunning(running);
    // Collapse exactly when running just flipped to false. If the user
    // had manually re-opened a completed reasoning card, this won't
    // fire again because `running` stays stable at false from then on.
    if (prevRunning && !running) setOpen(false);
  }

  if (stepCount === 0) return null;

  const headerLabel = running
    ? `Thinking · ${durationLabel} · ${stepCount} step${stepCount === 1 ? "" : "s"}`
    : failed
      ? `Thought for ${durationLabel} · ${stepCount} step${stepCount === 1 ? "" : "s"} · partial`
      : `Thought for ${durationLabel} · ${stepCount} step${stepCount === 1 ? "" : "s"}`;

  const headerTone = failed ? "#A23A2E" : running ? "#A66A00" : "#6B6560";

  return (
    <div
      style={{
        background: "#FBF8F3",
        border: "1px solid #EDE8DF",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Collapse reasoning" : "Expand reasoning"}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <ChevronRight
          size={12}
          color="#A39F99"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform .12s ease-out",
            flexShrink: 0,
          }}
        />
        {running ? (
          <span aria-hidden className="vt-reasoning-pulse" />
        ) : (
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: failed ? "#A23A2E" : "#4C7A3F",
              flexShrink: 0,
            }}
          />
        )}
        <span
          className="ds-mono-10"
          style={{
            color: headerTone,
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
          }}
        >
          {headerLabel}
        </span>
      </button>
      {open ? (
        <div
          style={{
            borderTop: "1px solid #F0E8DA",
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
