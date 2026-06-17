"use client";

import {
  Upload,
  MessageSquare,
  ClipboardPaste,
  Link,
  FileText,
  ArrowRight,
  Check,
  Sparkles,
} from "lucide-react";
import { useVantage, type OnboardMethod } from "@/lib/store";

const METHODS: { key: OnboardMethod; label: string; Icon: typeof Upload }[] = [
  { key: "upload", label: "Upload", Icon: Upload },
  { key: "chat", label: "Chat", Icon: MessageSquare },
  { key: "paste", label: "Paste", Icon: ClipboardPaste },
  { key: "link", label: "Link", Icon: Link },
];

const SKILLS = [
  "Design Systems",
  "User Research",
  "Prototyping",
  "Accessibility",
  "Design Leadership",
];

const SHIMMER_WIDTHS = ["72%", "90%", "58%", "80%"];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-brown">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <span className="font-display text-[18px] font-bold tracking-[3px] text-brown">VANTAGE</span>
    </div>
  );
}

function IdleState() {
  const onboardMethod = useVantage((s) => s.onboardMethod);
  const setOnboardMethod = useVantage((s) => s.setOnboardMethod);
  const startParse = useVantage((s) => s.startParse);
  const startByChat = useVantage((s) => s.startByChat);

  return (
    <div
      className="flex min-h-screen w-full flex-col items-center justify-center px-6 py-16"
      style={{ background: "radial-gradient(120% 120% at 50% 0%, #FFFFFF 0%, #FAF8F6 55%, #F5EDE3 100%)" }}
    >
      <div className="flex w-full max-w-[560px] flex-col items-center text-center">
        <div className="animate-fade-up">
          <Logo />
        </div>

        <h1 className="animate-fade-up mt-10 font-display text-[46px] font-bold leading-[1.08] -tracking-[0.5px] text-ink">
          Your job hunt, handled.
        </h1>

        <p className="animate-fade-up-delay mt-5 max-w-[420px] font-body text-[17px] leading-relaxed text-ink-light">
          Drop your résumé in. We find the roles, tailor each application, and prep
          you for every interview — you stay in control.
        </p>

        <div className="animate-fade-up-delay mt-9 flex items-center gap-2">
          {METHODS.map(({ key, label, Icon }) => {
            const active = onboardMethod === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setOnboardMethod(key)}
                className={
                  active
                    ? "flex items-center gap-2 rounded-full bg-brown px-4 py-2 font-body text-[14px] font-medium text-paper transition-colors"
                    : "flex items-center gap-2 rounded-full border border-border-dark bg-white px-4 py-2 font-body text-[14px] font-medium text-ink-light transition-colors hover:text-ink"
                }
              >
                <Icon size={15} strokeWidth={2} />
                {label}
              </button>
            );
          })}
        </div>

        <div className="animate-fade-up-delay mt-6 w-full">
          {onboardMethod === "upload" && (
            <button
              type="button"
              onClick={startParse}
              className="group flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border-dark bg-white/60 px-8 py-12 transition-colors hover:border-brown hover:bg-white"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cream text-amber">
                <FileText size={22} strokeWidth={1.75} />
              </div>
              <span className="font-display text-[17px] font-medium text-ink">Drop your résumé to begin</span>
              <span className="font-body text-[13px] text-ink-muted">PDF or DOCX · or click to browse</span>
            </button>
          )}

          {onboardMethod === "chat" && (
            <div className="flex w-full flex-col items-center gap-4 rounded-2xl border border-border bg-white px-8 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gold-bg text-amber">
                <Sparkles size={22} strokeWidth={1.75} />
              </div>
              <p className="font-display text-[17px] font-medium text-ink">No résumé? Build one by talking.</p>
              <p className="max-w-[360px] font-body text-[13px] text-ink-light">
                Answer a few questions and we&apos;ll draft a strong résumé from scratch.
              </p>
              <button
                type="button"
                onClick={startByChat}
                className="mt-1 inline-flex items-center gap-2 rounded-full bg-brown px-5 py-2.5 font-body text-[14px] font-medium text-paper transition-opacity hover:opacity-90"
              >
                Start a conversation
                <ArrowRight size={15} strokeWidth={2} />
              </button>
            </div>
          )}

          {onboardMethod === "paste" && (
            <div className="flex w-full flex-col gap-4 rounded-2xl border border-border bg-white p-5">
              <textarea
                placeholder="Paste your résumé text here…"
                className="h-40 w-full resize-none rounded-xl border border-border bg-paper px-4 py-3 font-body text-[14px] text-ink outline-none placeholder:text-ink-muted focus:border-border-dark"
              />
              <button
                type="button"
                onClick={startParse}
                className="self-end inline-flex items-center gap-2 rounded-full bg-brown px-5 py-2.5 font-body text-[14px] font-medium text-paper transition-opacity hover:opacity-90"
              >
                Parse résumé
                <ArrowRight size={15} strokeWidth={2} />
              </button>
            </div>
          )}

          {onboardMethod === "link" && (
            <div className="flex w-full flex-col gap-4 rounded-2xl border border-border bg-white p-5">
              <input
                type="url"
                placeholder="https://linkedin.com/in/your-profile"
                className="w-full rounded-xl border border-border bg-paper px-4 py-3 font-body text-[14px] text-ink outline-none placeholder:text-ink-muted focus:border-border-dark"
              />
              <button
                type="button"
                onClick={startParse}
                className="self-end inline-flex items-center gap-2 rounded-full bg-brown px-5 py-2.5 font-body text-[14px] font-medium text-paper transition-opacity hover:opacity-90"
              >
                Import
                <ArrowRight size={15} strokeWidth={2} />
              </button>
            </div>
          )}
        </div>

        <p className="animate-fade-up-delay mt-8 font-mono text-[11px] text-ink-muted">
          Password never stored · your data can stay on your device
        </p>
      </div>
    </div>
  );
}

function ParsingState() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-6 py-16">
      <div className="animate-fade-up w-full max-w-[460px] rounded-2xl border border-border bg-white p-7 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-cream text-amber">
            <FileText size={20} strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <p className="truncate font-display text-[15px] font-medium text-ink">Jordan-Avery-Resume.pdf</p>
            <p className="font-body text-[13px] text-amber">Reading your experience…</p>
          </div>
        </div>

        <div className="mt-7 flex flex-col gap-3">
          {SHIMMER_WIDTHS.map((w, i) => (
            <div
              key={i}
              className="animate-shimmer h-3.5 rounded-full bg-gradient-to-r from-[#F3F0EB] via-[#FAF6F0] to-[#F3F0EB]"
              style={{ width: w }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DoneState() {
  const enterApp = useVantage((s) => s.enterApp);

  return (
    <div className="flex min-h-screen w-full items-center justify-center px-6 py-16">
      <div className="animate-pop w-full max-w-[460px] rounded-2xl border border-border bg-white p-7 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green text-white">
            <Check size={12} strokeWidth={3} />
          </div>
          <span className="font-mono text-[11px] font-medium tracking-[1.5px] text-green">RÉSUMÉ UNDERSTOOD</span>
        </div>

        <h2 className="mt-4 font-display text-[24px] font-bold text-ink">Jordan Avery</h2>
        <p className="mt-1 font-body text-[14px] text-ink-light">
          Senior Product Designer · 7 years · San Francisco
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {SKILLS.map((skill) => (
            <span
              key={skill}
              className="rounded-full border border-cream-border bg-cream px-3 py-1.5 font-body text-[12.5px] font-medium text-amber"
            >
              {skill}
            </span>
          ))}
        </div>

        <div className="my-6 h-px w-full bg-border" />

        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 text-green">
            <Sparkles size={17} strokeWidth={2} />
          </div>
          <p className="font-body text-[14px] leading-relaxed text-ink">
            <span className="font-semibold text-green">38 matching roles found</span> — 6 are a strong
            fit, and we&apos;ve started tailoring your applications.
          </p>
        </div>

        <button
          type="button"
          onClick={enterApp}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full bg-brown px-5 py-3 font-body text-[15px] font-medium text-paper transition-opacity hover:opacity-90"
        >
          See your matches
          <ArrowRight size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export function OnboardingScreen() {
  const parseStage = useVantage((s) => s.parseStage);

  if (parseStage === "parsing") return <ParsingState />;
  if (parseStage === "done") return <DoneState />;
  return <IdleState />;
}
