"use client";

/**
 * step-card.tsx — dispatches a single step to its kind-specific card and
 * provides the shared visual frame (left gutter + card surface) every
 * non-user card reuses.
 *
 * Subscription model (plan constraint #3): each card calls useStep(id)
 * itself, so a delta on one step only re-renders that card — the timeline
 * never re-renders the whole list on every token.
 *
 * Caller: web/src/components/ask-vantage/step-timeline.tsx
 */

import type { CSSProperties, ReactNode } from "react";
import { useStep } from "@/lib/agent-events";
import type { Step } from "@/lib/agent-events";

import { ThinkingCard } from "./cards/thinking-card";
import { ToolCard } from "./cards/tool-card";
import { AssistantTextCard } from "./cards/assistant-text-card";
import { FileEditCard } from "./cards/file-edit-card";
import { BrowserCard } from "./cards/browser-card";
import { HitlCard } from "./cards/hitl-card";
import { NarratorCard } from "./cards/narrator-card";
import { ArtifactCard } from "./cards/artifact-card";
import { PartialArtifactCard } from "./cards/partial-artifact-card";
import { TaskGraphCard } from "./cards/task-graph-card";
import { UserCard } from "./cards/user-card";

export function StepCard({ id }: { id: string }) {
  const step = useStep(id);
  if (!step) return null;
  // The reducer never produces "user"; the store injects it via pushUserStep.
  // Compare on the raw string so TS's narrowed StepKind union doesn't reject it.
  if ((step.kind as string) === "user") return <UserCard step={step} />;
  switch (step.kind) {
    case "thinking":
      return <ThinkingCard step={step} />;
    case "tool":
      return <ToolCard step={step} />;
    case "assistant_text":
      return <AssistantTextCard step={step} />;
    case "file_edit":
      return <FileEditCard step={step} />;
    case "browser":
      return <BrowserCard step={step} />;
    case "hitl":
      return <HitlCard step={step} />;
    case "narrator":
      return <NarratorCard step={step} />;
    case "artifact":
      // A still-streaming artifact renders as the partial preview card;
      // once done it supersedes with the final artifact card.
      return step.status === "running" ? (
        <PartialArtifactCard step={step} />
      ) : (
        <ArtifactCard step={step} />
      );
    case "plan":
      return <TaskGraphCard step={step} />;
    case "run":
      return null; // root container — not a card
    default:
      return null;
  }
}

// ---------------------------------------------------------------- shared frame

/**
 * CardFrame — the gutter (28px avatar lane) + card surface chrome every
 * agent-side card reuses. User bubbles render right-aligned and don't use
 * this frame.
 */
export function CardFrame({
  children,
  testId,
  surface = true,
}: {
  children: ReactNode;
  testId?: string;
  surface?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className="animate-pop"
      style={{ display: "flex", gap: 9, alignItems: "flex-start" }}
    >
      <div style={{ width: 28, flexShrink: 0 }} />
      <div style={surface ? cardSurface : { flex: 1, minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

const cardSurface: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "#FFFFFF",
  border: "1px solid #E8DCCA",
  borderRadius: 12,
  overflow: "hidden",
};

// Status → accent color shared across cards.
export function statusColor(status: Step["status"]): string {
  switch (status) {
    case "done":
      return "#4C7A3F";
    case "failed":
      return "#A23A2E";
    case "review":
      return "#8A6A12";
    default:
      return "#A66A00";
  }
}
