/**
 * store.ts — Zustand store for the AG-UI step timeline + the turn
 * orchestration (sendAsk / sendResume). This replaces the old
 * ask-stream.ts + ask-vantage-store.ts *message* model. The dock chrome
 * (width / open-state / composer input / recent rail) still lives in
 * ask-vantage-store.ts; this store owns only the live step graph.
 *
 * Design (plan PR3 constraints #3, #4)
 * ------------------------------------
 * - `subscribeWithSelector` so each StepCard subscribes to *its own* step
 *   via `useStep(id)` and only re-renders when that step changes.
 * - The Map + order array are produced by the pure reducer (reducer.ts);
 *   the store just folds events into it and exposes selectors.
 * - sendAsk owns the AbortController + streaming flag and mirrors the
 *   streaming flag into the dock-chrome store so the composer disables.
 *
 * HITL resume (plan constraint #9): a HITL decision is a *new run* —
 * sendResume POSTs `{thread_id, command: {resume: <decision>}}` to the same
 * /api/ask/stream endpoint, and the continuation folds into the same step
 * map (the turn was never reset, so prior steps stay visible).
 *
 * Callers: dock.tsx, step-timeline.tsx, step-card.tsx + cards (useStep/
 * useStepIds/useIsStreaming); hitl-card.tsx (sendResume); today-view.tsx
 * and mock-interview.tsx (sendAsk).
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import type { AgentEvent, Step, StepKind } from "./schema";
import {
  applyEvent,
  emptyState,
  upsertStep,
  type ReducerState,
} from "./reducer";
import { consumeAgentStream } from "./consumer";
import { useDock } from "@/lib/ask-vantage-store";

// Client-injected step kinds the reducer never produces (the user's own
// prompt bubble). We widen StepKind locally for these without touching the
// PR1-frozen schema union.
export type RenderStepKind = StepKind | "user";

interface AgentStreamState {
  steps: Map<string, Step>;
  order: string[];
  rootStepId: string | null;
  isStreaming: boolean;
  /** Set on RUN_ERROR / transport failure so the timeline can show a footer. */
  errorMessage: string | null;
  abortController: AbortController | null;

  pushEvent: (e: AgentEvent) => void;
  pushUserStep: (text: string) => void;
  setStreaming: (v: boolean) => void;
  setError: (msg: string | null) => void;
  setAbort: (c: AbortController | null) => void;
  reset: () => void;
}

function toReducerState(s: AgentStreamState): ReducerState {
  return { steps: s.steps, order: s.order, rootStepId: s.rootStepId };
}

let userStepCounter = 0;

export const useAgentStream = create<AgentStreamState>()(
  subscribeWithSelector((set, get) => ({
    steps: new Map(),
    order: [],
    rootStepId: null,
    isStreaming: false,
    errorMessage: null,
    abortController: null,

    pushEvent: (e) => {
      const next = applyEvent(toReducerState(get()), e);
      set({ steps: next.steps, order: next.order, rootStepId: next.rootStepId });
    },

    pushUserStep: (text) => {
      const id = `user:${Date.now()}:${userStepCounter++}`;
      // Build directly with the widened render kind — schema's StepKind
      // doesn't include "user", so we construct the object and cast once.
      // The UserCard switch matches the literal at runtime.
      const step: Step = {
        id,
        run_id: "",
        kind: "user" as RenderStepKind as StepKind,
        status: "done",
        title: "You",
        started_at: Date.now(),
        text,
        events: [],
      };
      const next = upsertStep(toReducerState(get()), step);
      set({ steps: next.steps, order: next.order });
    },

    setStreaming: (v) => set({ isStreaming: v }),
    setError: (msg) => set({ errorMessage: msg }),
    setAbort: (c) => set({ abortController: c }),

    reset: () => {
      const cur = get().abortController;
      if (cur) cur.abort();
      const fresh = emptyState();
      set({
        steps: fresh.steps,
        order: fresh.order,
        rootStepId: fresh.rootStepId,
        isStreaming: false,
        errorMessage: null,
        abortController: null,
      });
    },
  })),
);

// ---------------------------------------------------------------- selectors

/** Subscribe to a single step by id — only re-renders when *that* step changes. */
export function useStep(id: string): Step | undefined {
  return useAgentStream((s) => s.steps.get(id));
}

/**
 * Ordered, render-eligible step ids. We hide the root "run" step (it's a
 * container, not a card) and sort by insertion order. useShallow keeps the
 * array snapshot stable so the timeline doesn't churn on every event.
 */
export function useStepIds(): string[] {
  return useAgentStream(
    useShallow((s) => {
      const out: string[] = [];
      for (const id of s.order) {
        const step = s.steps.get(id);
        if (!step) continue;
        if (step.kind === "run") continue; // root container — not a card
        out.push(id);
      }
      return out;
    }),
  );
}

export function useIsStreaming(): boolean {
  return useAgentStream((s) => s.isStreaming);
}

export function useStreamError(): string | null {
  return useAgentStream((s) => s.errorMessage);
}

/** True when there is at least one rendered step (drives greeting vs timeline). */
export function useHasSteps(): boolean {
  return useAgentStream((s) =>
    s.order.some((id) => s.steps.get(id)?.kind !== "run"),
  );
}

// ---------------------------------------------------------------- orchestration

export type AskSurface =
  | "dock"
  | "resume_studio"
  | "mock_studio"
  | "applications";

export interface SendAskOptions {
  surface?: AskSurface;
  threadIdOverride?: string;
}

export interface DockAttachmentLite {
  id: string;
  name: string;
}

function attachmentsFooter(atts: DockAttachmentLite[]): string {
  if (atts.length === 0) return "";
  const lines = atts.map((a) => `- ${a.name} (file_id: ${a.id})`);
  return `\n\n[Attached files]\n${lines.join("\n")}`;
}

/**
 * Drive one dock turn. Resets the step graph, injects the user's prompt as
 * a "user" step, then streams AG-UI events into the reducer. Mirrors the
 * streaming flag into the dock-chrome store so the composer disables.
 */
export async function sendAsk(
  prompt: string,
  attachments: DockAttachmentLite[] = [],
  opts: SendAskOptions = {},
): Promise<void> {
  const dock = useDock.getState();
  const threadId = opts.threadIdOverride ?? dock.threadId;
  if (!prompt.trim() || !threadId) return;

  const stream = useAgentStream.getState();
  // New turn replaces the old one (timeline is per-turn).
  stream.reset();
  dock.cancelStream?.();

  const footer = attachmentsFooter(attachments);
  const wirePrompt = `${prompt}${footer}`;
  if (attachments.length > 0) dock.clearAttachments();

  stream.pushUserStep(wirePrompt);

  // Optimistic recent rail (dock surface only) — keeps the lifetime
  // ask_vantage history strip in sync with the new turn.
  if (!opts.surface || opts.surface === "dock") {
    dock.prependRecentAnchor({
      id: `user-${Date.now()}`,
      preview: wirePrompt,
      createdAt: new Date().toISOString(),
    });
  }

  const controller = new AbortController();
  stream.setAbort(controller);
  stream.setStreaming(true);
  useDock.setState({ abortController: controller, streaming: true, input: "" });

  await consumeAgentStream({
    body: {
      prompt: wirePrompt,
      thread_id: threadId,
      ...(opts.surface ? { surface: opts.surface } : {}),
    },
    abortController: controller,
    callbacks: makeStreamCallbacks(controller),
  });
}

/**
 * Resume a paused HITL run. Per plan constraint #9 this is a *new run* on
 * the same thread carrying `command: {resume: <decision>}`. The continuation
 * folds into the existing step graph (no reset — prior steps stay visible).
 */
export async function sendResume(
  threadId: string,
  decision: unknown,
): Promise<void> {
  if (!threadId) return;
  const stream = useAgentStream.getState();
  const controller = new AbortController();
  stream.setAbort(controller);
  stream.setStreaming(true);
  stream.setError(null);
  useDock.setState({ abortController: controller, streaming: true });

  await consumeAgentStream({
    body: {
      thread_id: threadId,
      command: { resume: decision },
    },
    abortController: controller,
    callbacks: makeStreamCallbacks(controller),
  });
}

function makeStreamCallbacks(controller: AbortController) {
  const stream = useAgentStream.getState();
  // Only clear the streaming flag if *this* controller still owns it (a
  // newer send may have replaced it).
  const ownsController = () =>
    useAgentStream.getState().abortController === controller ||
    useAgentStream.getState().abortController === null;
  const clearOwned = () => {
    if (ownsController()) {
      useAgentStream.setState({ isStreaming: false, abortController: null });
      useDock.setState({ streaming: false, abortController: null });
    }
  };
  return {
    onEvent: (e: AgentEvent) => {
      stream.pushEvent(e);
      // RUN_ERROR carries a user-facing message; surface it on the timeline.
      if (e.type === "RUN_ERROR") {
        useAgentStream.setState({ errorMessage: e.message });
      }
    },
    onError: (err: Error) => {
      useAgentStream.setState({ errorMessage: err.message });
      clearOwned();
    },
    onDone: () => {
      clearOwned();
    },
  };
}

/** Cancel the in-flight turn (composer Stop, dock close, unmount). */
export function cancelAgentStream(): void {
  const cur = useAgentStream.getState().abortController;
  if (cur) cur.abort();
  useAgentStream.setState({ isStreaming: false, abortController: null });
}
