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
import { useStepIds, useStreamError } from "@/lib/agent-events";
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

  if (ids.length > VIRTUALIZE_THRESHOLD) {
    return <VirtualTimeline ids={ids} scrollRef={scrollRef} error={error} />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {ids.map((id) => (
        <StepCard key={id} id={id} />
      ))}
      {error ? <ErrorFooter message={error} /> : null}
    </div>
  );
}

function VirtualTimeline({
  ids,
  scrollRef,
  error,
}: {
  ids: string[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  error: string | null;
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
      {error ? <ErrorFooter message={error} /> : null}
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
