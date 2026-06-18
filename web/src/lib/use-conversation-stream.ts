// useConversationStream — local-component variant of the dock's send/SSE
// loop, for the per-document vibe chats described in
// vantage-ui-mapping.md §2.6.
//
// The dock has its own zustand pool (useDock) because it outlives every
// surface mount and persists to localStorage. A studio vibe chat is the
// opposite: its lifetime is the surface mount, so the messages and the
// streaming flag live in React state. Both call into the same low-level
// runAskStream from ask-stream.ts so the SSE / NDJSON contract has one
// implementation.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  runAskStream,
  type AskSurface,
} from "./ask-stream";
import {
  type AgentEvent,
  type DockMessage,
} from "./ask-vantage-store";

// Reuse the dock's message shape so the shared renderer (conversation.tsx)
// can render either pool transparently. The renderer reads .kind to switch
// between user / assistant / agents / result bubbles.
export type VibeChatMessage = DockMessage;

const AGENT_LABELS: Record<string, string> = {
  resume_agent: "RÉSUMÉ AGENT",
  jobmatch_agent: "SCOUT AGENT",
  interview_agent: "INTERVIEW AGENT",
  appprep_agent: "APPLICATION AGENT",
  trend_agent: "TREND AGENT",
  coordinator: "COORDINATOR",
};

export interface UseConversationStreamOpts {
  // Thread id for this surface — e.g. resume_studio_thread_id() output.
  // null while the host is still figuring out which row we're viewing;
  // in that case sendMessage is a no-op.
  threadId: string | null;
  surface: AskSurface;
  // Seed the conversation. Called once at mount. The hook owns the
  // message list afterwards.
  seed?: VibeChatMessage[];
  // When this changes, the message buffer resets and any in-flight stream
  // is aborted. The studio uses it to switch between résumé branches —
  // each branch has its own thread, so the conversation should swap with
  // the viewing context.
  resetKey?: string | null;
}

export interface UseConversationStreamReturn {
  messages: VibeChatMessage[];
  agentEvents: Record<string, AgentEvent>;
  streaming: boolean;
  send: (prompt: string) => Promise<void>;
  cancel: () => void;
  // Lets the caller reset between résumé branches without a remount.
  reset: () => void;
}

function newId(prefix: string): string {
  // Stable enough for React keys + agent event lookup. Conversation
  // streams are short-lived so collision probability is negligible.
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useConversationStream(
  opts: UseConversationStreamOpts,
): UseConversationStreamReturn {
  const { threadId, surface, seed, resetKey } = opts;

  const [messages, setMessages] = useState<VibeChatMessage[]>(seed ?? []);
  const [agentEvents, setAgentEvents] = useState<Record<string, AgentEvent>>({});
  const [streaming, setStreaming] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // Track which assistant bubble belongs to the *current* in-flight stream.
  // Mirrors the dock's "ourBubbleAlive" guard so a superseded stream can't
  // mutate a freshly-mounted bubble after a reset.
  const liveTurnRef = useRef<{
    assistantId: string;
    agentGroupId: string;
    assistantBuf: string;
    groupAgentIds: string[];
  } | null>(null);

  const cancelInternal = useCallback(() => {
    const c = controllerRef.current;
    if (c) {
      try {
        c.abort();
      } catch {
        /* AbortError is fine */
      }
      controllerRef.current = null;
    }
    setStreaming(false);
  }, []);

  // Switching context (e.g. selecting a different résumé branch) wipes the
  // local conversation. We don't navigate away, so a useEffect cleanup
  // would never run — we depend on resetKey instead.
  useEffect(() => {
    if (resetKey === undefined) return;
    cancelInternal();
    setMessages(seed ?? []);
    setAgentEvents({});
    liveTurnRef.current = null;
    // seed is intentionally not in the dep array — it would re-seed every
    // render and clobber the user's in-progress conversation. resetKey is
    // the explicit "swap context now" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, cancelInternal]);

  // Abort any in-flight stream on unmount so a pending fetch doesn't write
  // to a freed component.
  useEffect(() => {
    return () => cancelInternal();
  }, [cancelInternal]);

  const reset = useCallback(() => {
    cancelInternal();
    setMessages(seed ?? []);
    setAgentEvents({});
    liveTurnRef.current = null;
  }, [cancelInternal, seed]);

  const cancel = useCallback(() => {
    cancelInternal();
  }, [cancelInternal]);

  const send = useCallback(
    async (prompt: string): Promise<void> => {
      const text = prompt.trim();
      if (!text || !threadId) return;

      // Supersede any in-flight stream so a new question replaces the old.
      cancelInternal();

      const userId = newId("u");
      const assistantId = newId("a");
      const agentGroupId = newId("ag");
      const turn = {
        assistantId,
        agentGroupId,
        assistantBuf: "",
        groupAgentIds: [] as string[],
      };
      liveTurnRef.current = turn;

      setMessages((cur) => [
        ...cur,
        { id: userId, kind: "user", text },
        { id: assistantId, kind: "assistant", text: "" },
        { id: agentGroupId, kind: "agents", agents: [] },
      ]);

      const controller = new AbortController();
      controllerRef.current = controller;
      setStreaming(true);

      // "is the live turn still ours?" — supersedes after a reset.
      const ourTurnAlive = () => liveTurnRef.current === turn;

      const updateAssistant = (delta: string) => {
        if (!ourTurnAlive()) return;
        turn.assistantBuf += delta;
        setMessages((cur) =>
          cur.map((m) =>
            m.id === assistantId ? { ...m, text: turn.assistantBuf } : m,
          ),
        );
      };

      const finishAgent = (
        agent: string,
        state: "done" | "failed",
        statusText: string,
      ) => {
        setAgentEvents((cur) => {
          const target = turn.groupAgentIds
            .map((id) => cur[id])
            .filter(Boolean)
            .reverse()
            .find((e) => e.agent === agent && e.state === "running");
          if (!target) return cur;
          return { ...cur, [target.id]: { ...target, state, statusText } };
        });
      };

      const clearOwnedStreamState = () => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setStreaming(false);
        }
      };

      try {
        await runAskStream({
          prompt: text,
          threadId,
          surface,
          abortController: controller,
          callbacks: {
            onAssistantDelta: updateAssistant,
            onAgentStart: (agent, label) => {
              if (!ourTurnAlive()) return;
              const id = `ev-${agent}-${Date.now()}-${turn.groupAgentIds.length}`;
              const ev: AgentEvent = {
                id,
                agent,
                label:
                  label ||
                  `${AGENT_LABELS[agent] ?? agent.toUpperCase()} · running`,
                state: "running",
                statusText: "running",
                ts: Date.now(),
              };
              turn.groupAgentIds.push(id);
              setAgentEvents((cur) => ({ ...cur, [id]: ev }));
              setMessages((cur) =>
                cur.map((m) =>
                  m.id === agentGroupId
                    ? { ...m, agents: [...turn.groupAgentIds] }
                    : m,
                ),
              );
            },
            onAgentDone: (agent, statusText) => {
              if (!ourTurnAlive()) return;
              finishAgent(agent, "done", statusText);
            },
            onAgentFailed: (agent, statusText) => {
              if (!ourTurnAlive()) return;
              finishAgent(agent, "failed", statusText);
            },
            onResult: ({ title, sub, action, route }) => {
              if (!ourTurnAlive()) return;
              setMessages((cur) => [
                ...cur,
                {
                  id: newId("r"),
                  kind: "result",
                  title,
                  sub,
                  action,
                  onAction: route
                    ? () => {
                        if (typeof window !== "undefined")
                          window.location.assign(route);
                      }
                    : undefined,
                },
              ]);
            },
            onDone: () => {
              clearOwnedStreamState();
            },
            onError: (kind, message) => {
              if (kind === "frame") {
                updateAssistant(`\n\n_${message}_`);
              } else if (kind === "timeout") {
                updateAssistant("\n\n_Vantage stream timed out. Try again._");
              } else {
                updateAssistant(
                  "\n\n_Lost connection to Vantage. Try again._",
                );
              }
              clearOwnedStreamState();
            },
          },
        });
      } finally {
        clearOwnedStreamState();
      }
    },
    [cancelInternal, surface, threadId],
  );

  return { messages, agentEvents, streaming, send, cancel, reset };
}
