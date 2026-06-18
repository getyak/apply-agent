"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useVantage } from "@/lib/store";
import { firstNameOf, fullGreeting, formatToday } from "@/lib/dates";
import { Check, Send, Zap, CheckCircle2, Mic } from "lucide-react";

const SUGGESTIONS = [
  { label: "Find new roles that fit me", id: "find" },
  { label: "Tailor my résumé for a role", id: "tailor" },
  { label: "Prep me for an interview", id: "prep" },
  { label: "Show me today's market", id: "market" },
];

export function ChatView() {
  const router = useRouter();
  const chatLog = useVantage((s) => s.chatLog);
  const sendChat = useVantage((s) => s.sendChat);
  const runFlow = useVantage((s) => s.runFlow);
  const chatInput = useVantage((s) => s.chatInput);
  const setChatInput = useVantage((s) => s.setChatInput);
  const sendRealChat = useVantage((s) => s.sendRealChat);
  const chatMessages = useVantage((s) => s.chatMessages);
  const chatLoading = useVantage((s) => s.chatLoading);
  const chatHydrating = useVantage((s) => s.chatHydrating);
  const currentUser = useVantage((s) => s.currentUser);
  const parsedResume = useVantage((s) => s.parsedResume);
  const loadCurrentUser = useVantage((s) => s.loadCurrentUser);
  const hydrateChat = useVantage((s) => s.hydrateChat);
  const hasLog = chatLog.length > 0 || chatMessages.length > 0;

  useEffect(() => {
    if (!currentUser) loadCurrentUser();
    // Replay any persisted conversation so it survives a reload (no-op if there
    // is no stored session or it's already loaded).
    hydrateChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstName =
    firstNameOf(parsedResume?.basics?.name) || firstNameOf(currentUser?.displayName);
  const headerDate = useMemo(() => formatToday(), []);
  const greeting = useMemo(() => fullGreeting(firstName), [firstName]);

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {chatHydrating && !hasLog && (
          <div className="max-w-[720px] mx-auto px-10 pt-[84px] flex items-center gap-[10px]">
            <div className="w-4 h-4 rounded-full border-2 border-[#F0E4D2] border-t-amber animate-spin shrink-0" />
            <span className="font-body text-[15px] text-ink-light animate-pulse">
              Loading your conversation…
            </span>
          </div>
        )}

        {!hasLog && !chatHydrating && (
          <div className="max-w-[720px] mx-auto px-10 pt-[84px] pb-[30px] animate-fade-up">
            <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-3">
              {headerDate}
            </div>
            <h1 className="font-display font-bold text-[34px] -tracking-[0.4px] text-ink mb-2">
              {greeting}
            </h1>
            <p className="font-body text-[17px] leading-[1.5] text-ink-light mb-[30px]">
              What should we work on? Ask anything — or launch a task and
              I&apos;ll run the agents.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {SUGGESTIONS.map((s) => (
                <div
                  key={s.id}
                  onClick={() => runFlow(s.id)}
                  className="cursor-pointer bg-white border border-border rounded-[13px] px-[18px] py-4 flex items-center gap-3 shadow-sm hover:border-brown hover:-translate-y-px transition-all"
                >
                  <div className="w-8 h-8 rounded-[9px] bg-cream flex items-center justify-center shrink-0">
                    <Zap className="w-4 h-4 text-brown" strokeWidth={1.8} />
                  </div>
                  <span className="font-body font-medium text-[14.5px] text-ink">
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasLog && (
          <div className="max-w-[720px] mx-auto px-10 pt-9 pb-5 flex flex-col gap-[18px]">
            {chatLog.map((entry) => (
              <div key={entry.key} className="flex flex-col gap-3">
                <div className="flex justify-end w-full">
                  <div className="bg-brown text-paper font-body text-[15px] leading-[1.5] px-4 py-[10px] rounded-[13px] rounded-br-[4px] max-w-[460px]">
                    Find new roles that fit my profile
                  </div>
                </div>

                <div className="flex gap-[10px] items-start">
                  <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                    <Check className="w-[15px] h-[15px] text-paper" strokeWidth={2.2} />
                  </div>
                  <div className="font-body text-[15px] leading-[1.55] text-ink max-w-[520px]">
                    On it — scanning job boards and matching against your skills
                    and experience.
                  </div>
                </div>

                <div className="flex gap-[10px] items-start">
                  <div className="w-[30px] shrink-0" />
                  <div className="flex flex-col gap-2 flex-1 max-w-[520px]">
                    <div className="flex items-center gap-[11px] bg-white border border-cream-border rounded-[10px] px-[14px] py-[11px]">
                      {entry.phase < 1 ? (
                        <div className="w-4 h-4 rounded-full border-2 border-[#F0E4D2] border-t-amber animate-spin shrink-0" />
                      ) : (
                        <div className="w-[22px] h-[22px] rounded-[6px] bg-cream flex items-center justify-center shrink-0">
                          <Zap className="w-[13px] h-[13px] text-brown" strokeWidth={2} />
                        </div>
                      )}
                      <span className="font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                        Job scanner
                      </span>
                      <span className={`ml-auto font-mono text-[10px] tracking-[0.5px] uppercase ${entry.phase < 1 ? "text-amber" : "text-green"}`}>
                        {entry.phase < 1 ? "scanning…" : "done"}
                      </span>
                    </div>
                  </div>
                </div>

                {entry.phase >= 1 && (
                  <div className="flex gap-[10px] items-start">
                    <div className="w-[30px] shrink-0" />
                    <div className="flex-1 max-w-[520px] bg-[#FFFBF4] border border-cream-border rounded-[13px] px-[18px] py-4 flex items-center gap-[14px] animate-pop">
                      <div className="w-[38px] h-[38px] rounded-[10px] bg-green-bg flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-[19px] h-[19px] text-green" strokeWidth={2} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-body font-semibold text-[15px] text-ink">
                          5 matching roles found
                        </div>
                        <div className="font-body text-[13px] text-ink-light mt-[2px]">
                          3 are ready to apply — check your briefing
                        </div>
                      </div>
                      <button
                        onClick={() => router.push("/app/today")}
                        className="cursor-pointer border-none bg-brown text-paper font-body font-semibold text-[13px] px-4 py-[10px] rounded-[9px] whitespace-nowrap shrink-0 hover:bg-brown-light transition-colors"
                      >
                        View matches
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatMessages.map((msg, i) => (
              <div key={`real-${i}`} className="flex flex-col gap-3">
                {msg.role === "user" ? (
                  <div className="flex justify-end w-full">
                    <div className="bg-brown text-paper font-body text-[15px] leading-[1.5] px-4 py-[10px] rounded-[13px] rounded-br-[4px] max-w-[460px]">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-[10px] items-start">
                    <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                      <Check className="w-[15px] h-[15px] text-paper" strokeWidth={2.2} />
                    </div>
                    <div className="font-body text-[15px] leading-[1.55] text-ink max-w-[520px] whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatLoading && (
              <div className="flex gap-[10px] items-start">
                <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                  <div className="w-4 h-4 rounded-full border-2 border-paper/30 border-t-paper animate-spin" />
                </div>
                <div className="font-body text-[15px] text-ink-light animate-pulse">
                  Thinking...
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-paper/90 backdrop-blur-xl px-10 py-4 pb-[22px]">
        <div className="max-w-[720px] mx-auto">
          {hasLog && (
            <div className="flex flex-wrap gap-2 mb-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => runFlow(s.id)}
                  className="cursor-pointer bg-white border border-border-dark text-ink font-body font-medium text-[12.5px] px-[13px] py-[7px] rounded-full hover:border-brown hover:bg-[#FFFDFB] transition-all"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {/* Claude-Code-style composer: trailing edge shows mic when empty,
              send when there's content. Both Enter and ⌘↵/Ctrl↵ submit. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (chatInput.trim()) sendRealChat();
              else sendChat();
            }}
            className="flex items-center gap-[10px] bg-white border border-border-dark rounded-[13px] pl-[18px] pr-[7px] py-[7px] shadow-sm"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (chatInput.trim()) sendRealChat();
                  else sendChat();
                }
              }}
              placeholder="Ask anything, or launch a task…"
              className="flex-1 font-body text-[15px] text-ink bg-transparent border-none outline-none placeholder:text-ink-muted"
            />
            <span className="font-mono text-[9px] tracking-[0.6px] uppercase text-ink-muted whitespace-nowrap mr-1 select-none">
              ⌘↵ SEND
            </span>
            {chatInput.trim().length > 0 ? (
              <button
                type="submit"
                aria-label="Send"
                title="Send (⌘↵)"
                className="cursor-pointer border-none bg-brown w-[38px] h-[38px] rounded-[10px] flex items-center justify-center shrink-0 hover:bg-brown-light transition-colors"
              >
                <Send className="w-[17px] h-[17px] text-paper" strokeWidth={2} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Voice input"
                title="Voice input (coming soon)"
                className="cursor-pointer border border-border bg-white text-ink-light w-[38px] h-[38px] rounded-[10px] flex items-center justify-center shrink-0 hover:border-brown hover:text-brown transition-colors"
              >
                <Mic className="w-[17px] h-[17px]" strokeWidth={2} />
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
