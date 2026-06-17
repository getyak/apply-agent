"use client";

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
        <h1 className="font-display font-bold text-[34px] -tracking-[0.4px] text-ink mb-[10px]">
          Rehearse before it counts.
        </h1>
        <p className="font-body text-[16px] leading-[1.55] text-ink-light mb-7">
          A live, AI-led mock interview tuned to a real role you&apos;re up for.
          It asks, follows up, and coaches you after every answer.
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

  const levelLabel =
    mockLevel === "warmup"
      ? "Warm-up"
      : mockLevel === "standard"
        ? "Standard"
        : "Pressure";

  const scoreData = [
    {
      label: "Structure",
      pct: Math.min(20 + mockAnswers.length * 18, 85),
      color: "#4C7A3F",
    },
    {
      label: "Specificity",
      pct: Math.min(15 + mockAnswers.length * 16, 78),
      color: "#5D3000",
    },
    {
      label: "Confidence",
      pct: Math.min(25 + mockAnswers.length * 14, 72),
      color: "#A66A00",
    },
  ];

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
          <div className="font-mono text-[10px] tracking-[0.5px] uppercase text-ink-muted">
            {job.co} · {levelLabel}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-[7px] font-mono text-[11px] tracking-[0.6px] uppercase text-brown bg-cream border border-cream-border px-3 py-[6px] rounded-full">
          <span className="w-[7px] h-[7px] rounded-full bg-[#A23A2E]" />
          Question {Math.min(qIdx + 1, 5)} of 5
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

          <div className="font-display font-bold text-[11px] tracking-[1.3px] uppercase text-ink-light mb-[13px]">
            Questions
          </div>
          <div className="flex flex-col gap-[9px]">
            {MOCK_PROGRESS_LABELS.map((label, i) => {
              const done = i < mockAnswers.length;
              const active = i === qIdx && !isComplete;
              return (
                <div key={label} className="flex items-center gap-[10px]">
                  <div
                    className={`w-[20px] h-[20px] rounded-[5px] flex items-center justify-center shrink-0 ${
                      done
                        ? "bg-brown"
                        : active
                          ? "bg-cream border border-cream-border"
                          : "bg-border"
                    }`}
                  >
                    {done && (
                      <Check
                        className="w-[11px] h-[11px] text-paper"
                        strokeWidth={3}
                      />
                    )}
                  </div>
                  <span
                    className={`font-body text-[13px] ${
                      done
                        ? "text-ink font-medium"
                        : active
                          ? "text-ink"
                          : "text-ink-muted"
                    }`}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

export function MockScreen() {
  const mockState = useVantage((s) => s.mockState);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-paper animate-fade-in">
      {mockState === "setup" && <SetupScreen />}
      {mockState === "live" && <LiveSession />}
    </div>
  );
}
