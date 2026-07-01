"use client";

/**
 * step-timeline.tsx — renders the live AG-UI step list. Reads only the
 * *ordered ids* from the store (useStepIds); each StepCard subscribes to its
 * own step, so a token delta on one step never re-renders the whole list.
 *
 * Virtualization (plan constraint #5): once the step count exceeds
 * VIRTUALIZE_THRESHOLD we switch to @tanstack/react-virtual; below it we
 * render the plain list (variable card heights + small counts make the
 * non-virtual path simpler and avoids measurement jitter).
 *
 * Caller: web/src/components/ask-vantage/dock.tsx (replaces the old
 * messages.map render body).
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslations } from "next-intl";
import {
  useReconnectAttempt,
  useStepIds,
  useStreamError,
  useStreamExpired,
} from "@/lib/agent-events";
import { StepCard } from "./step-card";

const VIRTUALIZE_THRESHOLD = 30;

export function StepTimeline({
  scrollRef,
}: {
  // Shared with the dock so its auto-scroll-to-bottom effect targets the
  // same element the virtualizer measures.
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ids = useStepIds();
  const error = useStreamError();
  const reconnectAttempt = useReconnectAttempt();
  const streamExpired = useStreamExpired();

  const footer = renderFooter({ reconnectAttempt, streamExpired, error });

  if (ids.length > VIRTUALIZE_THRESHOLD) {
    return <VirtualTimeline ids={ids} scrollRef={scrollRef} footer={footer} />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {ids.map((id) => (
        <StepCard key={id} id={id} />
      ))}
      {footer}
    </div>
  );
}

function renderFooter(args: {
  reconnectAttempt: number;
  streamExpired: boolean;
  error: string | null;
}) {
  // Priority: expired > reconnecting > error. Only one footer at a time —
  // stacking them would just add noise for a user who already sees the
  // stream is unhappy.
  if (args.streamExpired) return <StreamExpiredFooter />;
  if (args.reconnectAttempt > 0)
    return <ReconnectingFooter attempt={args.reconnectAttempt} />;
  if (args.error) return <ErrorFooter message={args.error} />;
  return null;
}

function VirtualTimeline({
  ids,
  scrollRef,
  footer,
}: {
  ids: string[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  footer: React.ReactNode;
}) {
  const v = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    gap: 16,
  });
  return (
    <div style={{ position: "relative", height: v.getTotalSize() }}>
      {v.getVirtualItems().map((row) => (
        <div
          key={ids[row.index]}
          ref={v.measureElement}
          data-index={row.index}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${row.start}px)`,
          }}
        >
          <StepCard id={ids[row.index]} />
        </div>
      ))}
      {footer}
    </div>
  );
}

function ErrorFooter({ message }: { message: string }) {
  const t = useTranslations("dock");
  return (
    <div
      data-testid="step-timeline-error"
      style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
    >
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        role="alert"
        style={{
          flex: 1,
          minWidth: 0,
          border: "1px solid #E2C1BB",
          background: "#FCF3F1",
          borderRadius: 10,
          padding: "10px 12px",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 12.5,
          color: "#7A2A1F",
        }}
      >
        {t("message.streamError", { message })}
      </div>
    </div>
  );
}

/**
 * Inline "Reconnecting…" pill shown while the D4 resume-by-cursor
 * consumer retries a dropped connection. Non-blocking — no icon spam,
 * no full-width banner. Just a quiet acknowledgement that the stream
 * is still live-adjacent.
 */
function ReconnectingFooter({ attempt }: { attempt: number }) {
  const t = useTranslations("dock");
  // Best-effort i18n: fall back to English if the messages file hasn't
  // been extended yet. Never crash — a missing key just shows the raw
  // template string with the {attempt} filled in.
  let label: string;
  try {
    label = t("message.reconnecting", { attempt });
  } catch {
    label = `Reconnecting… (${attempt}/3)`;
  }
  return (
    <div
      data-testid="step-timeline-reconnecting"
      style={{ display: "flex", gap: 9, alignItems: "center" }}
    >
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        role="status"
        aria-live="polite"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid #DED3B8",
          background: "#FFFDF3",
          borderRadius: 999,
          padding: "6px 12px",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 12.5,
          color: "#8A6A00",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: "#D4A62A",
            animation: "relayPulse 1.2s ease-in-out infinite",
          }}
        />
        <span>{label}</span>
        <style>
          {`@keyframes relayPulse { 0%,100% { opacity: 0.35 } 50% { opacity: 1 } }`}
        </style>
      </div>
    </div>
  );
}

/**
 * Terminal "Stream expired · Start over" affordance: shown when the
 * server signalled the resume buffer was pruned past our cursor. The
 * click handler triggers a fresh POST (no cursor) via the same
 * ``sendAsk`` path — history stays intact.
 */
function StreamExpiredFooter() {
  const t = useTranslations("dock");
  let title: string;
  let body: string;
  let cta: string;
  try {
    title = t("message.streamExpired.title");
    body = t("message.streamExpired.body");
    cta = t("message.streamExpired.cta");
  } catch {
    title = "Stream expired";
    body = "We couldn't pick up where we left off. Start a fresh turn.";
    cta = "Start over";
  }
  return (
    <div
      data-testid="step-timeline-stream-expired"
      style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
    >
      <div style={{ width: 28, flexShrink: 0 }} />
      <div
        role="alert"
        style={{
          flex: 1,
          minWidth: 0,
          border: "1px solid #D8CFB4",
          background: "#FBF7EB",
          borderRadius: 10,
          padding: "12px 14px",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 13,
          color: "#5F4B00",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12.5, opacity: 0.85 }}>{body}</div>
        <button
          type="button"
          onClick={() => {
            // Fresh turn: the composer's onSubmit path handles the
            // network side. We can't send a prompt from here (we don't
            // know what the user wanted), so we clear the expired flag
            // and let them retype. That's the honest thing to do —
            // silently re-sending a lost prompt is worse UX than
            // asking for confirmation.
            import("@/lib/agent-events").then((m) => {
              m.useAgentStream
                .getState()
                .setStreamExpired(false);
              m.useAgentStream.getState().setError(null);
            });
          }}
          style={{
            marginTop: 8,
            border: "1px solid #B8A76A",
            background: "#FFFDF3",
            borderRadius: 6,
            padding: "5px 10px",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {cta}
        </button>
      </div>
    </div>
  );
}
