"use client";

// Mock interview — conversation-driven with pluggable modes.
//
// Per docs/architecture/vantage-ui-mapping.md §3 and Vantage.dc.html
// lines 585–813, this surface walks a four-stage flow:
//
//   modes   ▸ four built-in modes + custom (slugs: scene_recreation,
//             pressure_drill, warm_up, rapid_fire — matches the
//             013 migration seed)
//   intel   ▸ pre-session brief (only shown when mode.intel != none)
//   live    ▸ chat-style Q/A, with "what the interviewer heard"
//             translation cards instead of 1-5 scores
//   debrief ▸ interview card + close-the-loop CTA
//
// The flow stage lives in local React state. The store's mockState
// stays at "live" / "setup" for backward compat with onboarding code.

import { useEffect, useMemo, useState } from "react";
import {
  useVantage,
  MOCK_QS,
  MOCK_PROGRESS_LABELS,
  INTERVIEWING_DATA,
} from "@/lib/store";
import { ArrowLeft, ArrowRight, Send, X, Mic, Check } from "lucide-react";
import { Button, Chip, HintBox } from "@/components/ui";
import { initialsOf } from "@/lib/dates";

// The mock-interview screen is the closest to a "live" demo of Relay's interview-coach surface.
// Until store.startMockSession() exists (see TODO WEB-009 + AGENT-033), the chips/feedback are
// still the curated MOCK_QS demo — but we ground identity (user initials, job interviewing)
// in real data when available, fall back to the first real interview application, and surface
// an EmptyState when there's nothing to practice against at all.
function SetupScreen() {
  const mockLevel = useVantage((s) => s.mockLevel);
  const setMockLevel = useVantage((s) => s.setMockLevel);
  const startMock = useVantage((s) => s.startMock);
  const backHome = useVantage((s) => s.backHome);
  const apiApplications = useVantage((s) => s.apiApplications);

  // Prefer a real "interviewing" application if the user has one — otherwise fall back to the
  // scripted demo INTERVIEWING_DATA so the surface is never empty for first-run users.
  const realInterview = apiApplications.find((a) => a.status === "interview");
  const job = realInterview
    ? {
        mono: realInterview.company.charAt(0).toUpperCase(),
        co: realInterview.company,
        role: realInterview.role_title,
        stage: "Recruiter screen",
        when: "soon",
      }
    : INTERVIEWING_DATA[0];

  const levels = [
    { key: "warmup" as const, label: "Warm-up" },
    { key: "standard" as const, label: "Standard" },
    { key: "pressure" as const, label: "Pressure" },
  ];

  return (
    <div
      className="flex-1 flex items-center justify-center overflow-auto p-8"
      style={{ background: "radial-gradient(120% 100% at 50% 0%, #FFFDFB 0%, var(--color-paper) 60%)" }}
    >
      <div className="w-[520px] max-w-full animate-fade-up">
        <Button
          onClick={backHome}
          variant="ghost"
          size="sm"
          leadingIcon={<ArrowLeft size={16} strokeWidth={1.8} />}
          className="mb-5 !px-[6px]"
        >
          Back
        </Button>
        <div className="font-mono text-[11px] tracking-[1px] uppercase text-amber mb-[10px]">
          Mock interview
        </div>

        <h1
          style={{
            fontFamily: "Inter",
            fontWeight: 600,
            fontSize: 32,
            lineHeight: 1.15,
            letterSpacing: -0.5,
            color: M.ink,
            margin: "0 0 12px",
          }}
        >
          Pick how you want to rehearse.
        </h1>
        <p
          style={{
            fontFamily: "Inter",
            fontSize: 15,
            lineHeight: 1.55,
            color: M.body,
            margin: "0 0 32px",
            maxWidth: 560,
          }}
        >
          Each mode is a different way to practise for a real round.
        </p>

        <div className="bg-white border border-border rounded-[14px] p-[22px] shadow-sm mb-4">
          <div className="font-display font-bold text-[10px] tracking-[1.4px] uppercase text-ink-muted mb-[13px]">
            Practising for
          </div>
          <div className="flex items-center gap-[13px] mb-[18px]">
            <div
              className="w-[46px] h-[46px] rounded-[11px] bg-cream flex items-center justify-center font-display font-bold text-[18px] text-ink"
              aria-label={`${job.co} interview`}
            >
              {job.mono}
            </div>
            <div>
              <div className="font-body font-semibold text-[16px] text-ink">
                {job.role}
              </div>
              <div className="font-body text-[13px] text-ink-light">
                {job.co} · {job.stage} · {realInterview ? "live application" : "demo"} {job.when}
              </div>
            </div>
          </div>
          <div className="font-display font-bold text-[10px] tracking-[1.4px] uppercase text-ink-muted mb-[9px]">
            Intensity
          </div>
          <div className="flex gap-2">
            {levels.map((lv) => (
              <Button
                key={lv.key}
                onClick={() => setMockLevel(lv.key)}
                variant={mockLevel === lv.key ? "primary" : "secondary"}
                size="sm"
              >
                {lv.label}
              </Button>
            ))}
          </div>
        </div>

        <Button
          onClick={startMock}
          fullWidth
          size="lg"
          trailingIcon={<ArrowRight size={17} strokeWidth={2} />}
        >
          Start session
        </Button>
        <div className="text-center mt-3 font-mono text-[10px] tracking-[0.5px] uppercase text-ink-muted">
          5 questions · ~10 min · coached live
        </div>
      </div>
    </div>
  );
}

function LiveSession() {
  const mockAnswers = useVantage((s) => s.mockAnswers);
  const pendingAnswer = useVantage((s) => s.pendingAnswer);
  const mockThinking = useVantage((s) => s.mockThinking);
  const mockLevel = useVantage((s) => s.mockLevel);
  const answerMock = useVantage((s) => s.answerMock);
  const sendMock = useVantage((s) => s.sendMock);
  const restartMock = useVantage((s) => s.restartMock);
  const backHome = useVantage((s) => s.backHome);
  const apiApplications = useVantage((s) => s.apiApplications);
  const parsedResume = useVantage((s) => s.parsedResume);
  const currentUser = useVantage((s) => s.currentUser);

  const realInterview = apiApplications.find((a) => a.status === "interview");
  const job = realInterview
    ? {
        mono: realInterview.company.charAt(0).toUpperCase(),
        co: realInterview.company,
        role: realInterview.role_title,
      }
    : { mono: INTERVIEWING_DATA[0].mono, co: INTERVIEWING_DATA[0].co, role: INTERVIEWING_DATA[0].role };

  const userName = parsedResume?.basics?.name || currentUser?.displayName || "You";
  const userInitials = initialsOf(userName);

  const qIdx = mockAnswers.length;
  const isComplete = qIdx >= MOCK_QS.length;
  const canAnswer = !isComplete && pendingAnswer === null && !mockThinking;

        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 11,
            letterSpacing: 1,
            color: M.muted,
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          Most likely questions
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
          {intel.freq.map((q) => (
            <div
              key={q.q}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                background: M.surface,
                border: `1px solid ${M.border}`,
                padding: "12px 14px",
                borderRadius: 8,
              }}
            >
              <span style={{ flex: 1, fontFamily: "Inter", fontSize: 14, color: M.ink }}>{q.q}</span>
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: 11,
                  fontWeight: 500,
                  color: M.body,
                  letterSpacing: 0.4,
                }}
              >
                {q.p}
              </span>
            </div>
          ))}
        </div>

        {/* THE TRAP — the one place a red accent earns its keep. */}
        <div
          style={{
            background: M.dangerBg,
            border: `1px solid ${M.dangerBorder}`,
            borderRadius: 10,
            padding: "16px 18px",
            marginBottom: 28,
          }}
        >
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 10.5,
              letterSpacing: 1,
              color: M.danger,
              marginBottom: 8,
            }}
          >
            THE TRAP
          </div>
          <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 15, color: M.ink, marginBottom: 6 }}>
            {intel.trap.q}
          </div>
          <div style={{ fontFamily: "Inter", fontSize: 13.5, lineHeight: 1.55, color: M.body }}>
            {intel.trap.note}
          </div>
        </div>

        <button onClick={onBegin} style={primaryBtnStyle()}>
          I&apos;m ready — start
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={M.surface} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function LiveStage({
  job,
  mode,
  initials,
  messages,
  pendingAnswer,
  setPendingAnswer,
  onBack,
  onSend,
  progressIdx,
}: {
  job: { mono: string; co: string; role: string };
  mode: BuiltInMode;
  initials: string;
  messages: MockMessage[];
  pendingAnswer: string;
  setPendingAnswer: (v: string) => void;
  onBack: () => void;
  onSend: () => void;
  progressIdx: number;
}) {
  const total = MOCK_QS.length;
  const curr = Math.min(progressIdx + 1, total);
  // Topics breakdown becomes a hover tooltip in the progress pill so the
  // right-rail is gone entirely — the live screen is now single-column,
  // centered, and immersive. Tooltip text is plain HTML title for now.
  const tooltip = MOCK_PROGRESS_LABELS.map((label, i) => {
    const marker = i < progressIdx ? "✓" : i === progressIdx ? "›" : " ";
    return `${marker} ${label}`;
  }).join("\n");

  return (
    <>
      <div className="h-[60px] shrink-0 border-b border-border bg-paper/85 backdrop-blur-xl flex items-center px-6 gap-[14px]">
        <button
          onClick={backHome}
          aria-label="Close mock interview"
          className="cursor-pointer border-none bg-transparent flex items-center text-ink-light p-1 hover:text-ink rounded outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          <X className="w-[19px] h-[19px]" strokeWidth={1.8} />
        </button>
        <div
          className="w-[30px] h-[30px] rounded-lg bg-cream flex items-center justify-center font-display font-bold text-[13px] text-ink"
          aria-label={`${job.co} interview`}
        >
          {job.mono}
        </div>
        <div>
          <div className="font-body font-semibold text-[14px] text-ink leading-[1.1]">
            {job.role}
          </div>
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 10.5,
              letterSpacing: 0.8,
              color: M.muted,
              textTransform: "uppercase",
              marginTop: 2,
            }}
          >
            {job.co} · {mode.name}
          </div>
        </div>
        <div
          title={tooltip}
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "JetBrains Mono",
            fontSize: 11,
            letterSpacing: 0.6,
            color: M.body,
            border: `1px solid ${M.border}`,
            padding: "5px 11px",
            borderRadius: 999,
            cursor: "default",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: M.accent }} />
          {curr} / {total}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto py-[30px]">
            <div className="max-w-[680px] mx-auto px-10 flex flex-col gap-5">
              {MOCK_QS.slice(0, qIdx + (isComplete ? 0 : 1)).map((q, i) => {
                const answered = i < mockAnswers.length;
                const isPending = i === qIdx && pendingAnswer !== null;

                return (
                  <div key={i} className="flex flex-col gap-3">
                    <div className="flex gap-[11px] items-start">
                      <div className="w-[34px] h-[34px] rounded-[9px] bg-ink text-paper shrink-0 flex items-center justify-center font-display font-bold text-[13px]">
                        {job.mono}
                      </div>
                      <div className="flex flex-col">
                        <div className="font-mono text-[9px] tracking-[0.6px] uppercase text-ink-muted mb-[6px]">
                          Interviewer
                        </div>
                        <div className="font-body text-[15px] leading-[1.55] text-ink max-w-[520px]">
                          {q.q}
                        </div>
                      </div>
                    </div>

                    {(answered || isPending) && (
                      <div className="flex gap-[11px] items-start justify-end">
                        <div className="flex flex-col items-end">
                          <div className="font-mono text-[9px] tracking-[0.6px] uppercase text-ink-muted mb-[6px]">
                            You
                          </div>
                          <div className="bg-brown text-paper font-body text-[14px] leading-[1.5] px-4 py-[10px] rounded-[13px] rounded-br-[4px] max-w-[460px]">
                            {isPending ? pendingAnswer : mockAnswers[i]}
                          </div>
                        </div>
                        <div
                          className="w-[34px] h-[34px] rounded-[9px] bg-cream-border text-brown shrink-0 flex items-center justify-center font-display font-bold text-[13px]"
                          aria-label={userName}
                        >
                          {userInitials}
                        </div>
                      </div>
                    )}

                    {answered && (
                      <div className="flex gap-[11px] items-start">
                        <div className="w-[34px] shrink-0" />
                        <HintBox label="Coach" tone="ai" className="max-w-[520px]">
                          {q.feedback}
                        </HintBox>
                      </div>
                    )}
                  </div>
                );
              })}

              {mockThinking && (
                <div className="flex gap-[11px] items-center">
                  <div className="w-[34px] h-[34px] rounded-[9px] bg-ink text-paper shrink-0 flex items-center justify-center font-display font-bold text-[13px]">
                    {job.mono}
                  </div>
                  <div className="flex gap-1">
                    <span className="w-[6px] h-[6px] rounded-full bg-border-dark animate-bob" />
                    <span className="w-[6px] h-[6px] rounded-full bg-border-dark animate-bob [animation-delay:0.15s]" />
                    <span className="w-[6px] h-[6px] rounded-full bg-border-dark animate-bob [animation-delay:0.3s]" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {canAnswer && (
            <div className="shrink-0 border-t border-border bg-paper px-10 pt-[14px] pb-[22px]">
              <div className="max-w-[680px] mx-auto">
                <div className="flex items-center gap-2 mb-[10px]">
                  <span className="font-mono text-[9px] tracking-[0.6px] uppercase text-ink-muted">
                    Suggested angle
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 mb-3">
                  {MOCK_QS[qIdx].chips.map((c) => (
                    <Chip key={c} onClick={() => answerMock(MOCK_QS[qIdx].sample)}>
                      {c}
                    </Chip>
                  ))}
                </div>
                <div className="flex items-center gap-[10px] bg-white border border-border-dark rounded-xl pl-4 pr-[5px] py-[5px]">
                  <button className="border-none bg-transparent cursor-pointer flex items-center text-ink-light shrink-0 hover:text-brown">
                    <Mic className="w-[18px] h-[18px]" strokeWidth={1.7} />
                  </button>
                  <span className="flex-1 font-body text-[14px] text-ink-muted">
                    Type your answer, or speak it…
                  </span>
                  <button
                    onClick={sendMock}
                    className="cursor-pointer border-none bg-brown w-[34px] h-[34px] rounded-[9px] flex items-center justify-center shrink-0 hover:bg-brown-light transition-colors"
                  >
                    <Send className="w-4 h-4 text-paper" strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {isComplete && (
            <div className="shrink-0 border-t border-border bg-white px-10 py-[18px]">
              <div className="max-w-[680px] mx-auto w-full flex items-center gap-4">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#4C7A3F"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0"
                  aria-hidden
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <path d="M22 4L12 14.01l-3-3" />
                </svg>
                <div className="flex-1 font-body text-[14px] text-ink">
                  Session complete. You&apos;re noticeably sharper on impact
                  metrics — bring that into the real round.
                </div>
                <Button onClick={restartMock} variant="secondary" size="sm">
                  Run it again
                </Button>
                <Button onClick={backHome} size="sm">
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="w-[300px] shrink-0 border-l border-border bg-cream overflow-y-auto px-6 py-7">
          <div className="font-display font-bold text-[11px] tracking-[1.3px] uppercase text-ink-light mb-4">
            Live read
          </div>
          <div className="flex flex-col gap-[18px] mb-7">
            {scoreData.map((sc) => (
              <div key={sc.label}>
                <div className="flex items-center justify-between mb-[7px]">
                  <span className="font-body font-medium text-[13px] text-ink">
                    {sc.label}
                  </span>
                  <span
                    className="font-mono text-[11px] font-medium"
                    style={{ color: sc.color }}
                  >
                    {sc.pct}%
                  </span>
                </div>
                <div className="h-[7px] rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 ease-out"
                    style={{ width: `${sc.pct}%`, background: sc.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flexShrink: 0, borderTop: `1px solid ${M.border}`, background: M.surface, padding: "16px 40px 24px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 10,
                background: M.surface,
                border: `1px solid ${M.borderStrong}`,
                borderRadius: 10,
                padding: "10px 10px 10px 14px",
              }}
            >
              <textarea
                value={pendingAnswer}
                onChange={(e) => setPendingAnswer(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter sends. Plain Enter inserts a newline — answering
                  // an interview question is rarely one short line, so don't punish
                  // the user for hitting Enter mid-thought.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                placeholder="Type your answer…   ⌘↵ to send"
                rows={3}
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  resize: "none",
                  fontFamily: "Inter",
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: M.ink,
                  padding: "4px 0",
                  background: "transparent",
                  minHeight: 60,
                  maxHeight: 200,
                }}
              />
              <button onClick={onSend} style={sendBtnStyle()} aria-label="Send answer">
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={M.surface} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function MessageBlock({
  m,
  job,
  initials,
}: {
  m: MockMessage;
  job: { mono: string };
  initials: string;
}) {
  // Mono section labels render in mute gray here so accent stays scarce.
  const monoLabel = (text: string, color = M.muted): React.CSSProperties => ({
    fontFamily: "JetBrains Mono",
    fontSize: 10,
    letterSpacing: 1,
    color,
    marginBottom: 6,
    textTransform: "uppercase",
  });

  if (m.role === "interviewer") {
    return (
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: M.ink,
            color: M.surface,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Inter",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          {job.mono}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {m.label && (
            <div style={monoLabel(m.label === "FOLLOW-UP" ? M.accent : M.muted)}>
              {m.label}
            </div>
          )}
          <div
            style={{
              background: M.surface,
              border: `1px solid ${M.border}`,
              borderRadius: 10,
              padding: "14px 16px",
              fontFamily: "Inter",
              fontSize: 16,
              lineHeight: 1.55,
              color: M.ink,
            }}
          >
            {m.text}
          </div>
        </div>
      </div>
    );
  }
  if (m.role === "user") {
    return (
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: 540,
            background: M.ink,
            color: M.surface,
            borderRadius: 10,
            padding: "14px 16px",
            fontFamily: "Inter",
            fontSize: 14,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {m.text}
        </div>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: M.surfaceAlt,
            color: M.ink,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Inter",
            fontWeight: 600,
            fontSize: 12,
            border: `1px solid ${M.border}`,
          }}
        >
          {initials}
        </div>
      </div>
    );
  }
  if (m.role === "translation" && m.feedback) {
    const fb = m.feedback;
    return (
      <div
        style={{
          marginLeft: 44,
          maxWidth: 600,
          background: M.surface,
          border: `1px solid ${M.border}`,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            borderBottom: `1px solid ${M.border}`,
            padding: "10px 16px",
            fontFamily: "JetBrains Mono",
            fontSize: 10.5,
            letterSpacing: 1,
            color: M.muted,
          }}
        >
          WHAT THE INTERVIEWER HEARD
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={monoLabel("YOU SAID")}>YOU SAID</div>
            <div style={{ fontFamily: "Inter", fontSize: 13.5, color: M.body, fontStyle: "italic", lineHeight: 1.55 }}>
              “{fb.said}”
            </div>
          </div>
          <div style={{ borderLeft: `2px solid ${M.borderStrong}`, paddingLeft: 14 }}>
            <div style={monoLabel("WHAT THEY HEARD")}>WHAT THEY HEARD</div>
            <div style={{ fontFamily: "Inter", fontSize: 14, color: M.ink, lineHeight: 1.55 }}>{fb.heard}</div>
          </div>
          <div style={{ borderLeft: `2px solid ${M.accent}`, paddingLeft: 14 }}>
            <div style={monoLabel("TRY INSTEAD")}>TRY INSTEAD</div>
            <div style={{ fontFamily: "Inter", fontSize: 14, color: M.ink, lineHeight: 1.55 }}>{fb.rephrase}</div>
          </div>
          {fb.stuck && (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", borderTop: `1px solid ${M.border}`, paddingTop: 14 }}>
              <span
                style={{
                  flexShrink: 0,
                  marginTop: 2,
                  fontFamily: "JetBrains Mono",
                  fontSize: 10,
                  letterSpacing: 1,
                  color: M.danger,
                }}
              >
                STUCK
              </span>
              <div style={{ fontFamily: "Inter", fontSize: 13, color: M.body, lineHeight: 1.55 }}>{fb.stuck}</div>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (m.role === "coach") {
    return (
      <div
        style={{
          marginLeft: 44,
          maxWidth: 560,
          background: M.surface,
          border: `1px solid ${M.border}`,
          borderLeft: `3px solid ${M.accent}`,
          borderRadius: 8,
          padding: "12px 16px",
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 10,
            letterSpacing: 1,
            color: M.muted,
            marginBottom: 5,
          }}
        >
          COACH
        </div>
        <div style={{ fontFamily: "Inter", fontSize: 14, color: M.ink, lineHeight: 1.55 }}>{m.text}</div>
      </div>
    );
  }
  return null;
}

// Per-topic "interviewer heard" lines for the debrief. One distinct sentence
// per topic — the previous version repeated the same string 5 times, which
// is the "假数据感强" the user called out. Kept inline (not from MOCK_QS)
// because these are debrief-specific framings, not the practice questions
// themselves. Replace with real translate_feedback() output once the
// interview_agent landing PR ships.
const DEBRIEF_HEARD: string[] = [
  "Confident framing, but they're listening for the decision you made — not the outcome.",
  "Clear on what happened. The trade-off you weighed against could be named earlier.",
  "Honest about the tension. Naming the metric you optimized for would land harder.",
  "Strong narrative. The follow-up will probe what you'd do differently — be ready.",
  "Closed well. One concrete number in the first sentence would have anchored it.",
];

function Debrief({
  job,
  focusNext,
  onRestart,
  onDone,
}: {
  job: { co: string };
  focusNext: string;
  onRestart: () => void;
  onDone: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "48px 32px 80px",
        background: M.paper,
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto" }} className="animate-fade-up">
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 11,
            letterSpacing: 1,
            color: M.muted,
            textTransform: "uppercase",
            marginBottom: 18,
          }}
        >
          Session complete
        </div>
        <h1
          style={{
            fontFamily: "Inter",
            fontWeight: 600,
            fontSize: 32,
            lineHeight: 1.15,
            letterSpacing: -0.5,
            color: M.ink,
            margin: "0 0 12px",
          }}
        >
          Your interview card.
        </h1>
        <p style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 1.55, color: M.body, margin: "0 0 32px" }}>
          How each answer read from the other side of the table — and what to carry into the real round.
        </p>

        {/* Topic list. No score tags — each row is a distinct read. */}
        <div
          style={{
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderRadius: 10,
            overflow: "hidden",
            marginBottom: 28,
          }}
        >
          {MOCK_PROGRESS_LABELS.map((topic, i) => {
            const isLast = i === MOCK_PROGRESS_LABELS.length - 1;
            const heard = DEBRIEF_HEARD[i] ?? DEBRIEF_HEARD[DEBRIEF_HEARD.length - 1];
            return (
              <div
                key={topic}
                style={{
                  padding: "16px 18px",
                  borderBottom: isLast ? "none" : `1px solid ${M.border}`,
                  display: "flex",
                  gap: 16,
                  alignItems: "flex-start",
                }}
              >
                <div
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: 11,
                    color: M.muted,
                    width: 22,
                    flexShrink: 0,
                    paddingTop: 2,
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: M.ink, marginBottom: 4 }}>
                    {topic}
                  </div>
                  <div style={{ fontFamily: "Inter", fontSize: 13.5, lineHeight: 1.55, color: M.body }}>
                    {heard}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Close-the-loop — neutral card, accent only on icon. */}
        <div
          style={{
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderRadius: 10,
            padding: "18px 20px",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 10.5,
              letterSpacing: 1,
              color: M.muted,
              marginBottom: 10,
            }}
          >
            CLOSE THE LOOP
          </div>
          <div style={{ fontFamily: "Inter", fontSize: 14, lineHeight: 1.6, color: M.body, marginBottom: 14 }}>
            After the real {job.co} screen, come back and log what they actually asked. Vantage learns your real weak spots — not generic advice.
          </div>
          <button
            style={{
              cursor: "pointer",
              border: `1px solid ${M.borderStrong}`,
              background: M.surface,
              color: M.ink,
              fontFamily: "Inter",
              fontWeight: 500,
              fontSize: 13,
              padding: "9px 14px",
              borderRadius: 8,
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Log the real interview
          </button>
        </div>

        {/* Weak-spots focus — white surface with accent left rail, matching
            the translation card's TRY INSTEAD treatment from LiveStage. */}
        <div
          style={{
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderLeft: `3px solid ${M.accent}`,
            borderRadius: 8,
            padding: "16px 20px",
            marginBottom: 28,
          }}
        >
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 10.5,
              letterSpacing: 1,
              color: M.muted,
              marginBottom: 8,
            }}
          >
            NEXT SESSION OPENS ON
          </div>
          <div style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 1.55, color: M.ink }}>
            <b style={{ fontWeight: 600 }}>{focusNext}</b>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={onRestart} style={secondaryBtnStyle()}>Run it again</button>
          <button onClick={onDone} style={primaryBtnStyle({ marginTop: 0, flex: 1.4 })}>Done</button>
        </div>
      </div>
    </div>
  );
}

function ghostBtnStyle(): React.CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "Inter",
    fontWeight: 500,
    fontSize: 13,
    color: M.body,
    padding: "6px 4px",
    marginBottom: 18,
  };
}

function modeCardStyle(selected: boolean): React.CSSProperties {
  return {
    cursor: "pointer",
    textAlign: "left",
    background: M.surface,
    border: `1px solid ${selected ? M.borderInk : M.border}`,
    borderRadius: 10,
    padding: "16px 18px",
    transition: "border-color .12s ease",
    outline: "none",
  };
}

function primaryBtnStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    width: "100%",
    marginTop: 28,
    cursor: "pointer",
    border: "none",
    background: M.ink,
    color: M.surface,
    fontFamily: "Inter",
    fontWeight: 500,
    fontSize: 14,
    padding: "12px 16px",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    ...extra,
  };
}

function secondaryBtnStyle(): React.CSSProperties {
  return {
    flex: 1,
    cursor: "pointer",
    border: `1px solid ${M.borderStrong}`,
    background: M.surface,
    color: M.ink,
    fontFamily: "Inter",
    fontWeight: 500,
    fontSize: 14,
    padding: "12px 16px",
    borderRadius: 8,
  };
}

function iconBtnStyleInk(): React.CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    color: M.body,
    padding: 4,
  };
}

function sendBtnStyle(): React.CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    background: M.ink,
    width: 36,
    height: 36,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

// Rough wall-clock estimate by intel strategy. Used in the HITL confirm so
// the user sees what they're committing to before the timer starts.
function estimatedDurationMin(intel: IntelStrategy): number {
  switch (intel) {
    case "none":
      return 10;
    case "jd_based":
      return 15;
    case "crowdsourced":
      return 20;
    case "recruiter_specific":
      return 25;
  }
}

function StartConfirmModal({
  mode,
  questionCount,
  onCancel,
  onConfirm,
}: {
  mode: BuiltInMode;
  questionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const mins = estimatedDurationMin(mode.intel);
  // Esc to cancel — same affordance as native dialogs. We intentionally do
  // NOT add Enter to confirm here: starting a 10–25 min session should be
  // deliberate, never accidental.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mock-start-title"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10, 10, 10, 0.5)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-fade-up"
        style={{
          background: M.surface,
          border: `1px solid ${M.border}`,
          borderRadius: 12,
          padding: 28,
          maxWidth: 440,
          width: "100%",
          boxShadow: "0 20px 40px rgba(0,0,0,0.12)",
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 10.5,
            color: M.muted,
            letterSpacing: 1,
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          Ready to start?
        </div>
        <h2
          id="mock-start-title"
          style={{
            fontFamily: "Inter",
            fontWeight: 600,
            fontSize: 20,
            lineHeight: 1.3,
            color: M.ink,
            margin: "0 0 12px",
            letterSpacing: -0.3,
          }}
        >
          {mode.name} — about {mins} min, {questionCount} questions.
        </h2>
        <p
          style={{
            fontFamily: "Inter",
            fontSize: 14,
            lineHeight: 1.55,
            color: M.body,
            margin: "0 0 10px",
          }}
        >
          {mode.tagline}
        </p>
        <p
          style={{
            fontFamily: "Inter",
            fontSize: 13,
            lineHeight: 1.55,
            color: M.muted,
            margin: "0 0 24px",
          }}
        >
          Once you start, the timer runs. You can exit at any time — your answers won&apos;t be saved if you cancel.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: 1,
              cursor: "pointer",
              border: `1px solid ${M.border}`,
              background: M.surface,
              color: M.ink,
              fontFamily: "Inter",
              fontWeight: 500,
              fontSize: 14,
              padding: "11px 14px",
              borderRadius: 8,
            }}
          >
            Not yet
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            style={{
              flex: 1.4,
              cursor: "pointer",
              border: "none",
              background: M.ink,
              color: M.surface,
              fontFamily: "Inter",
              fontWeight: 500,
              fontSize: 14,
              padding: "11px 14px",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            Start the session
            <svg
              width={15}
              height={15}
              viewBox="0 0 24 24"
              fill="none"
              stroke={M.surface}
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
