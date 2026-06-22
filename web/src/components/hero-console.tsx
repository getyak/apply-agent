"use client";

import { useState, useCallback } from "react";
import {
  Upload,
  MessageSquare,
  ClipboardPaste,
  Link2,
  FileUp,
  Sparkles,
  Search,
  FileText,
  Pencil,
  ArrowRight,
  Check,
} from "lucide-react";

type Method = "upload" | "chat" | "paste" | "link";
type Phase = "entry" | "running" | "ready";

const methods: { key: Method; label: string; icon: React.ReactNode }[] = [
  { key: "upload", label: "Upload", icon: <Upload size={15} /> },
  { key: "chat", label: "Chat", icon: <MessageSquare size={15} /> },
  { key: "paste", label: "Paste", icon: <ClipboardPaste size={15} /> },
  { key: "link", label: "Link", icon: <Link2 size={15} /> },
];

export default function HeroConsole() {
  const [method, setMethod] = useState<Method>("upload");
  const [phase, setPhase] = useState<Phase>("entry");

  const startEntry = useCallback(() => {
    setPhase("running");
    setTimeout(() => setPhase("ready"), 2600);
  }, []);

  return (
    <div className="tilt-shine bg-dark rounded-[18px] border border-dark-border/40 shadow-[0_24px_70px_rgba(40,25,5,0.22)] overflow-hidden">
      {/* Title bar */}
      <div className="group h-[46px] border-b border-dark-border/40 flex items-center px-4 gap-2">
        <div className="dots flex gap-1.5">
          <span className="w-[11px] h-[11px] rounded-full bg-[#4a4238]" />
          <span className="w-[11px] h-[11px] rounded-full bg-[#4a4238]" />
          <span className="w-[11px] h-[11px] rounded-full bg-[#4a4238]" />
        </div>
        <span className="ml-2.5 font-mono text-[11px] tracking-[0.6px] uppercase text-dark-muted">
          vantage · start here
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] tracking-[0.5px] uppercase text-dark-gold">
          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse-dot" />
          live
        </span>
      </div>

      <div className="p-5 pb-[22px]">
        {phase === "entry" && (
          <div className="animate-fade-in">
            <div className="seg flex gap-[5px] bg-[#1b1812] border border-dark-border/40 rounded-xl p-1 mb-4">
              {methods.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setMethod(m.key)}
                  data-active={method === m.key}
                  className={`seg-item cursor-pointer flex-1 flex items-center justify-center gap-1.5 py-[9px] px-1.5 rounded-[9px] font-body font-semibold text-[12.5px] border ${
                    method === m.key
                      ? "bg-[#3a3022] text-[#FAF8F6] border-dark-border"
                      : "bg-transparent text-dark-muted border-transparent hover:text-[#d8d0c4]"
                  }`}
                >
                  {m.icon}
                  {m.label}
                </button>
              ))}
            </div>

            {method === "upload" && (
              <button
                onClick={startEntry}
                className="cursor-pointer w-full border-[1.5px] border-dashed border-dark-border rounded-[13px] p-[30px_20px] min-h-[190px] flex flex-col items-center justify-center gap-[13px] transition-all hover:border-dark-gold hover:bg-[#221d16] bg-transparent"
              >
                <div className="w-12 h-12 rounded-xl bg-[#352d22] flex items-center justify-center">
                  <FileUp size={23} className="text-dark-gold" />
                </div>
                <div className="text-center">
                  <div className="font-body font-semibold text-[15px] text-[#FAF8F6] mb-[3px]">
                    Drop your résumé to begin
                  </div>
                  <div className="font-body text-[13px] text-dark-muted">
                    PDF, DOCX — or click to browse
                  </div>
                </div>
              </button>
            )}

            {method === "chat" && (
              <div className="border border-dark-border/40 rounded-[13px] p-6 min-h-[190px] flex flex-col items-center justify-center gap-3 text-center">
                <div className="w-12 h-12 rounded-xl bg-brown flex items-center justify-center">
                  <Sparkles size={23} className="text-[#FAF8F6]" />
                </div>
                <div>
                  <div className="font-body font-semibold text-[15px] text-[#FAF8F6] mb-[3px]">
                    No résumé? Build it by talking.
                  </div>
                  <div className="font-body text-[13px] leading-[1.45] text-dark-muted max-w-[290px]">
                    Answer a few quick questions and we&apos;ll write it with you.
                  </div>
                </div>
                <button className="mt-0.5 font-body font-semibold text-sm text-dark bg-gold px-5 py-[11px] rounded-[10px] inline-flex items-center gap-[7px] hover:bg-gold-light transition-colors cursor-pointer border-none">
                  Start a conversation
                  <ArrowRight size={15} />
                </button>
              </div>
            )}

            {method === "paste" && (
              <div className="min-h-[190px] flex flex-col">
                <div className="flex-1 bg-[#1b1812] border border-dark-border/40 rounded-[11px] p-[14px_16px] font-body text-[13.5px] leading-[1.6] text-dark-muted text-left">
                  Paste your résumé text here — experience, skills, education.
                  We&apos;ll structure it into a profile for you.
                </div>
                <button
                  onClick={startEntry}
                  className="mt-3 self-end cursor-pointer border-none bg-gold text-dark font-body font-semibold text-[13.5px] px-[18px] py-[11px] rounded-[10px] hover:bg-gold-light transition-colors"
                >
                  Parse résumé
                </button>
              </div>
            )}

            {method === "link" && (
              <div className="min-h-[190px] flex flex-col justify-center gap-[13px]">
                <div className="font-body font-semibold text-sm text-[#FAF8F6] text-left">
                  Import from a link
                </div>
                <div className="flex items-center gap-[9px] bg-[#1b1812] border border-dark-border/40 rounded-[11px] p-[13px_15px]">
                  <Link2 size={16} className="text-dark-muted" />
                  <span className="flex-1 text-left font-body text-[13.5px] text-dark-muted">
                    linkedin.com/in/your-profile
                  </span>
                </div>
                <button
                  onClick={startEntry}
                  className="self-end cursor-pointer border-none bg-gold text-dark font-body font-semibold text-[13.5px] px-[18px] py-[11px] rounded-[10px] hover:bg-gold-light transition-colors"
                >
                  Import
                </button>
              </div>
            )}
          </div>
        )}

        {(phase === "running" || phase === "ready") && (
          <div className="animate-fade-in">
            <div className="flex justify-end mb-[18px] animate-step-in">
              <div className="bg-brown text-[#FAF8F6] rounded-[13px_13px_4px_13px] py-[11px] px-[15px] font-body text-[13.5px] leading-[1.45] max-w-[80%]">
                Here&apos;s my résumé — find roles and get me ready.
              </div>
            </div>

            <div className="flex flex-col gap-[11px]">
              {[
                {
                  icon: <Search size={14} />,
                  name: "Scout agent",
                  result: (
                    <>
                      Scanned{" "}
                      <span className="text-white font-semibold">1,240</span>{" "}
                      live roles → 8 strong fits
                    </>
                  ),
                  delay: "0.4s",
                },
                {
                  icon: <FileText size={14} />,
                  name: "Résumé agent",
                  result: "Tailored your résumé for each role",
                  delay: "1s",
                },
                {
                  icon: <Pencil size={14} />,
                  name: "Answer agent",
                  result: "Drafted screening answers from your story",
                  delay: "1.6s",
                },
              ].map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-start gap-[11px]"
                  style={{
                    animation: `step-in 0.5s ease-out ${agent.delay} both`,
                  }}
                >
                  <div className="w-[26px] h-[26px] rounded-[7px] bg-[#352d22] flex items-center justify-center shrink-0 text-dark-gold">
                    {agent.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[10px] tracking-[0.5px] uppercase text-dark-gold mb-[3px]">
                      {agent.name}
                    </div>
                    <div className="font-body text-[13px] leading-[1.4] text-[#cfc7bb]">
                      {agent.result}
                    </div>
                  </div>
                  <Check size={16} className="text-[#5bbf8a] shrink-0 mt-[3px]" strokeWidth={2.4} />
                </div>
              ))}
            </div>

            {phase === "ready" && (
              <div className="mt-[18px] bg-dark-card border border-dark-border rounded-[11px] p-[14px_15px] flex items-center gap-3 animate-step-in">
                <div className="w-[30px] h-[30px] rounded-lg bg-[#3a3022] flex items-center justify-center shrink-0">
                  <span className="font-display font-bold text-sm text-gold">8</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-body font-semibold text-[13.5px] text-[#FAF8F6]">
                    8 applications ready
                  </div>
                  <div className="font-body text-xs text-[#9a9082]">
                    You review and submit — in your own browser
                  </div>
                </div>
                <a
                  href="/auth?intent=start"
                  className="no-underline font-body font-semibold text-[13px] text-dark bg-gold px-[15px] py-[9px] rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap hover:bg-gold-light transition-colors"
                >
                  Enter
                  <ArrowRight size={14} />
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
