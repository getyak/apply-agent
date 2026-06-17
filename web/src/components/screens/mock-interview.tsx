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

import { useMemo, useState } from "react";
import {
  useVantage,
  MOCK_QS,
  MOCK_PROGRESS_LABELS,
  INTERVIEWING_DATA,
} from "@/lib/store";
import { initialsOf } from "@/lib/dates";

type IntelStrategy =
  | "none"
  | "jd_based"
  | "crowdsourced"
  | "recruiter_specific";
type PressureLevel = "encourage_only" | "one_follow_up" | "chained_to_stuck";
type FeedbackStyle =
  | "rating_1to5"
  | "three_perspective_translation"
  | "one_line_per_answer";
type LoopBehavior = "standalone" | "save_to_card" | "replay_real_interview";

interface BuiltInMode {
  slug: string;
  name: string;
  tagline: string;
  intel: IntelStrategy;
  pressure: PressureLevel;
  feedback: FeedbackStyle;
  loop: LoopBehavior;
}

// Mirrors infra/postgres/migrations/013_seed_interview_modes.up.sql. We
// inline here because the modes API isn't on the dev API gateway yet
// and the UI shouldn't block on an extra round-trip when these four are
// the product's load-bearing defaults. Custom modes append client-side
// once /api/interview-modes lands.
const BUILT_IN_MODES: BuiltInMode[] = [
  {
    slug: "scene_recreation",
    name: "Scene recreation",
    tagline:
      "Crowd-sourced intel and a single sharp follow-up. Closest to a real round.",
    intel: "crowdsourced",
    pressure: "one_follow_up",
    feedback: "three_perspective_translation",
    loop: "save_to_card",
  },
  {
    slug: "pressure_drill",
    name: "Pressure drill",
    tagline:
      "JD-grounded questions, chained follow-ups until you stick a landing.",
    intel: "jd_based",
    pressure: "chained_to_stuck",
    feedback: "three_perspective_translation",
    loop: "save_to_card",
  },
  {
    slug: "warm_up",
    name: "Warm-up",
    tagline:
      "No intel, gentle pacing. Use before a real round when you need momentum.",
    intel: "none",
    pressure: "encourage_only",
    feedback: "three_perspective_translation",
    loop: "standalone",
  },
  {
    slug: "rapid_fire",
    name: "Rapid fire",
    tagline:
      "No intel, no follow-ups — single-line feedback per answer. Highest reps.",
    intel: "none",
    pressure: "encourage_only",
    feedback: "one_line_per_answer",
    loop: "save_to_card",
  },
];

function modeDescriptor(m: BuiltInMode): string {
  const i =
    m.intel === "none"
      ? "NO INTEL"
      : m.intel === "jd_based"
        ? "JD INTEL"
        : m.intel === "crowdsourced"
          ? "CROWD INTEL"
          : "RECRUITER INTEL";
  const p =
    m.pressure === "encourage_only"
      ? "ENCOURAGING"
      : m.pressure === "one_follow_up"
        ? "ONE FOLLOW-UP"
        : "CHAINED";
  return `${i} · ${p}`;
}

function PressureBars({ level }: { level: PressureLevel }) {
  const filled =
    level === "encourage_only" ? 1 : level === "one_follow_up" ? 2 : 3;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: 9,
            borderRadius: 1,
            background: i <= filled ? "#5D3000" : "#E8DCCA",
          }}
        />
      ))}
    </span>
  );
}

type Stage = "modes" | "intel" | "live" | "debrief";

interface TranslationFeedback {
  said: string;
  heard: string;
  rephrase: string;
  stuck?: string;
}

interface MockMessage {
  role: "interviewer" | "user" | "translation" | "coach";
  text?: string;
  label?: string;
  labelColor?: string;
  feedback?: TranslationFeedback;
}

export function MockScreen() {
  const backHome = useVantage((s) => s.backHome);
  const apiApplications = useVantage((s) => s.apiApplications);
  const currentUser = useVantage((s) => s.currentUser);

  const [stage, setStage] = useState<Stage>("modes");
  const [selectedSlug, setSelectedSlug] = useState<string>("scene_recreation");
  const [qIdx, setQIdx] = useState(0);
  const [messages, setMessages] = useState<MockMessage[]>([]);
  const [pendingAnswer, setPendingAnswer] = useState<string>("");

  const selectedMode = useMemo(
    () => BUILT_IN_MODES.find((m) => m.slug === selectedSlug) ?? BUILT_IN_MODES[0],
    [selectedSlug],
  );

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

  const initials = initialsOf(currentUser?.displayName ?? "");

  const intel = {
    duration: "30 MIN",
    style:
      "Conversational. Stripe weighs craft and written communication heavily — expect a follow-up take-home, not a live exercise.",
    freq: [
      { q: "Walk me through a project you're proud of.", p: "94%" },
      { q: "Why Stripe, specifically?", p: "81%" },
      { q: "How do you handle disagreement with engineering?", p: "67%" },
    ],
    trap: {
      q: "Tell me about a time a design of yours failed.",
      note: "Easy to over-hedge here. Own it plainly, then show the correction with a number.",
    },
  };

  function onModePick(slug: string) {
    setSelectedSlug(slug);
  }

  function startMode() {
    const m = BUILT_IN_MODES.find((x) => x.slug === selectedSlug);
    if (!m) return;
    setQIdx(0);
    setMessages([]);
    if (m.intel === "none") {
      seedFirstQuestion();
      setStage("live");
    } else {
      setStage("intel");
    }
  }

  function beginLive() {
    seedFirstQuestion();
    setStage("live");
  }

  function seedFirstQuestion() {
    const first = MOCK_QS[0];
    setMessages([
      {
        role: "interviewer",
        text: first.q,
        label: "OPENING",
        labelColor: "#A66A00",
      },
    ]);
  }

  function sendAnswer() {
    const text = pendingAnswer.trim();
    if (!text) return;
    const cur = MOCK_QS[qIdx];
    if (!cur) return;
    setPendingAnswer("");

    const nextMsgs: MockMessage[] = [
      ...messages,
      { role: "user", text },
    ];

    if (selectedMode.feedback === "three_perspective_translation") {
      nextMsgs.push({
        role: "translation",
        feedback: {
          said: text,
          heard:
            "Confident, but they're listening for the *decision* you made — not just the outcome.",
          rephrase: cur.feedback,
          stuck:
            selectedMode.pressure === "chained_to_stuck"
              ? "Stuck on impact — next time, lead with the metric in one sentence."
              : undefined,
        },
      });
    } else if (selectedMode.feedback === "one_line_per_answer") {
      nextMsgs.push({
        role: "coach",
        text: cur.feedback,
      });
    }

    const nextIdx = qIdx + 1;
    if (nextIdx < MOCK_QS.length) {
      const followUp =
        selectedMode.pressure === "one_follow_up" ||
        selectedMode.pressure === "chained_to_stuck";
      const nq = MOCK_QS[nextIdx];
      nextMsgs.push({
        role: "interviewer",
        text: nq.q,
        label: followUp ? "FOLLOW-UP" : undefined,
        labelColor: followUp ? "#A23A2E" : "#A66A00",
      });
      setMessages(nextMsgs);
      setQIdx(nextIdx);
    } else {
      setMessages(nextMsgs);
      setStage("debrief");
    }
  }

  if (stage === "modes") {
    return (
      <Shell>
        <ModeGallery
          job={job}
          modes={BUILT_IN_MODES}
          selectedSlug={selectedSlug}
          onPick={onModePick}
          onStart={startMode}
          onBack={backHome}
        />
      </Shell>
    );
  }

  if (stage === "intel") {
    return (
      <Shell>
        <IntelBrief
          job={job}
          intel={intel}
          onBack={() => setStage("modes")}
          onBegin={beginLive}
        />
      </Shell>
    );
  }

  if (stage === "live") {
    return (
      <Shell>
        <LiveStage
          job={job}
          mode={selectedMode}
          initials={initials}
          messages={messages}
          pendingAnswer={pendingAnswer}
          setPendingAnswer={setPendingAnswer}
          onBack={() => setStage("modes")}
          onSend={sendAnswer}
          progressIdx={qIdx}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <Debrief
        job={job}
        focusNext="Owning impact, naming the metric early"
        onRestart={() => {
          setQIdx(0);
          setMessages([]);
          setStage("modes");
        }}
        onDone={backHome}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="animate-fade-in"
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#FAF8F6",
      }}
    >
      {children}
    </div>
  );
}

function ModeGallery({
  job,
  modes,
  selectedSlug,
  onPick,
  onStart,
  onBack,
}: {
  job: { mono: string; co: string; role: string; stage: string; when: string };
  modes: BuiltInMode[];
  selectedSlug: string;
  onPick: (slug: string) => void;
  onStart: () => void;
  onBack: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "38px 32px 64px",
        background: "radial-gradient(120% 80% at 50% 0%, #FFFDFB 0%, #FAF8F6 60%)",
      }}
    >
      <div style={{ maxWidth: 780, margin: "0 auto" }} className="animate-fade-up">
        <button onClick={onBack} style={ghostBtnStyle()}>
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Back
        </button>
        <div className="ds-mono-11" style={{ color: "#A66A00", marginBottom: 10 }}>
          MOCK INTERVIEW
        </div>
        <h1 className="ds-h1" style={{ margin: "0 0 10px" }}>Pick how you want to rehearse.</h1>
        <p className="ds-body-md" style={{ margin: "0 0 24px", color: "#6B6560", maxWidth: 560 }}>
          Each mode is a different way to practise for a real round — armed with intel, pushed under pressure, or warmed up gently.
        </p>

        <div className="ds-card" style={{ display: "flex", alignItems: "center", gap: 13, padding: "15px 18px", marginBottom: 22 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 11,
              background: "#F3F0EB",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "Space Grotesk",
              fontWeight: 700,
              fontSize: 16,
              color: "#2B2822",
              flexShrink: 0,
            }}
          >
            {job.mono}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ds-body-sm" style={{ fontWeight: 600, fontSize: 15 }}>{job.role}</div>
            <div className="ds-body-sm" style={{ fontSize: 13, color: "#6B6560" }}>
              {job.co} · {job.stage} · real interview {job.when}
            </div>
          </div>
          <span
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 9,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: "#A66A00",
              background: "#F8ECD6",
              padding: "4px 9px",
              borderRadius: 5,
            }}
          >
            Practising for
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {modes.map((m) => {
            const isSel = m.slug === selectedSlug;
            return (
              <button
                key={m.slug}
                onClick={() => onPick(m.slug)}
                style={modeCardStyle(isSel)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                  <span style={{ fontFamily: "Space Grotesk", fontWeight: 700, fontSize: 16, color: "#2B2822" }}>
                    {m.name}
                  </span>
                </div>
                <div className="ds-body-sm" style={{ fontSize: 13.5, color: "#6B6560", marginBottom: 14, minHeight: 40 }}>
                  {m.tagline}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="ds-mono-9" style={{ color: "#5D3000" }}>{modeDescriptor(m)}</span>
                  <span style={{ color: "#E2DACB" }}>·</span>
                  <PressureBars level={m.pressure} />
                </div>
              </button>
            );
          })}
        </div>

        <button onClick={onStart} style={primaryBtnStyle()}>
          Start · {modes.find((x) => x.slug === selectedSlug)?.name}
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function IntelBrief({
  job,
  intel,
  onBack,
  onBegin,
}: {
  job: { co: string; stage: string };
  intel: {
    duration: string;
    style: string;
    freq: { q: string; p: string }[];
    trap: { q: string; note: string };
  };
  onBack: () => void;
  onBegin: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "38px 32px 64px",
        background: "radial-gradient(120% 80% at 50% 0%, #FFFDFB 0%, #FAF8F6 60%)",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto" }} className="animate-fade-up">
        <button onClick={onBack} style={ghostBtnStyle()}>
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Modes
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#A66A00" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <circle cx={12} cy={12} r={10} />
            <circle cx={12} cy={12} r={6} />
            <circle cx={12} cy={12} r={2} />
          </svg>
          <span className="ds-mono-11" style={{ color: "#A66A00" }}>
            INTEL BRIEF · {job.co} · {job.stage}
          </span>
        </div>
        <h1 className="ds-h1" style={{ margin: "0 0 10px" }}>
          Before you rehearse — here&apos;s what this round actually asks.
        </h1>
        <p className="ds-body-md" style={{ fontSize: 15, color: "#6B6560", margin: "0 0 24px" }}>
          Pulled from our crowd-sourced question bank and public signals. We&apos;ll drill the likely ones first, then go random.
        </p>

        <div className="ds-card" style={{ padding: "18px 20px", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
            <span style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 15, color: "#2B2822" }}>
              {job.stage}
            </span>
            <span
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: 10,
                letterSpacing: 0.4,
                color: "#5D3000",
                background: "#F5EDE3",
                padding: "3px 9px",
                borderRadius: 5,
              }}
            >
              {intel.duration}
            </span>
          </div>
          <div className="ds-body-sm" style={{ fontSize: 13.5, lineHeight: 1.6, color: "#6B6560" }}>
            {intel.style}
          </div>
        </div>

        <div className="ds-label" style={{ marginBottom: 11 }}>MOST LIKELY QUESTIONS</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
          {intel.freq.map((q) => (
            <div
              key={q.q}
              className="ds-card"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 13,
                padding: "13px 16px",
                borderRadius: 11,
              }}
            >
              <span style={{ flex: 1, fontFamily: "Inter", fontSize: 14, color: "#2B2822" }}>{q.q}</span>
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: 11,
                  fontWeight: 500,
                  color: "#4C7A3F",
                  background: "#EBF3E5",
                  padding: "3px 9px",
                  borderRadius: 5,
                }}
              >
                {q.p}
              </span>
            </div>
          ))}
        </div>

        <div
          style={{
            background: "#FBEDEA",
            border: "1px solid #E8C4BC",
            borderRadius: 13,
            padding: "18px 20px",
            marginBottom: 22,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#A23A2E" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
            <span className="ds-mono-10" style={{ color: "#A23A2E" }}>THE TRAP</span>
          </div>
          <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 15, color: "#2B2822", marginBottom: 6 }}>
            {intel.trap.q}
          </div>
          <div style={{ fontFamily: "Inter", fontSize: 13.5, lineHeight: 1.6, color: "#7a3b32" }}>
            {intel.trap.note}
          </div>
        </div>

        <button onClick={onBegin} style={primaryBtnStyle()}>
          I&apos;m ready — start the session
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
  return (
    <>
      <div
        className="ds-backdrop"
        style={{
          height: 60,
          flexShrink: 0,
          borderBottom: "1px solid #EDE8DF",
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          gap: 14,
        }}
      >
        <button onClick={onBack} style={iconBtnStyleInk()}>
          <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "#2B2822",
            color: "#FAF8F6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {job.mono}
        </div>
        <div>
          <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: "#2B2822", lineHeight: 1.1 }}>
            {job.role}
          </div>
          <div className="ds-mono-10">{job.co.toUpperCase()} · {mode.name.toUpperCase()}</div>
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontFamily: "JetBrains Mono",
            fontSize: 11,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "#5D3000",
            background: "#F5EDE3",
            border: "1px solid #E8DCCA",
            padding: "6px 12px",
            borderRadius: 999,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: 999, background: "#A23A2E" }} />
          Topic {Math.min(progressIdx + 1, MOCK_QS.length)} of {MOCK_QS.length}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "30px 0" }}>
            <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 40px", display: "flex", flexDirection: "column", gap: 20 }}>
              {messages.map((m, i) => (
                <MessageBlock key={i} m={m} job={job} initials={initials} />
              ))}
            </div>
          </div>

          <div style={{ flexShrink: 0, borderTop: "1px solid #EDE8DF", background: "#FAF8F6", padding: "14px 40px 22px" }}>
            <div style={{ maxWidth: 700, margin: "0 auto" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "#FFFFFF",
                  border: "1px solid #D6CEC0",
                  borderRadius: 12,
                  padding: "5px 5px 5px 16px",
                }}
              >
                <input
                  value={pendingAnswer}
                  onChange={(e) => setPendingAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      onSend();
                    }
                  }}
                  placeholder="Type your answer, or speak it…"
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    fontFamily: "Inter",
                    fontSize: 14,
                    color: "#2B2822",
                    padding: "9px 0",
                    background: "transparent",
                  }}
                />
                <button onClick={onSend} style={sendBtnStyle()}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            width: 300,
            flexShrink: 0,
            borderLeft: "1px solid #EDE8DF",
            background: "#FBF8F3",
            overflowY: "auto",
            padding: "28px 24px",
          }}
        >
          <div className="ds-label" style={{ marginBottom: 12 }}>THIS MODE</div>
          <div className="ds-card" style={{ padding: 14, marginBottom: 26 }}>
            <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: "#2B2822", marginBottom: 4 }}>
              {mode.name}
            </div>
            <div className="ds-mono-10" style={{ color: "#A23A2E" }}>
              {modeDescriptor(mode)}
            </div>
          </div>
          <div className="ds-label" style={{ marginBottom: 13 }}>TOPICS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 24 }}>
            {MOCK_PROGRESS_LABELS.map((label, i) => {
              const done = i < progressIdx;
              const active = i === progressIdx;
              return (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 5,
                      background: done ? "#5D3000" : active ? "#F5EDE3" : "#EDE8DF",
                      border: active ? "1px solid #E8DCCA" : "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {done && (
                      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </div>
                  <span
                    style={{
                      fontFamily: "Inter",
                      fontSize: 13,
                      color: done ? "#2B2822" : active ? "#2B2822" : "#A39F99",
                      fontWeight: done ? 500 : 400,
                    }}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
          <div
            style={{
              background: "#FFFBF4",
              border: "1px solid #E8DCCA",
              borderRadius: 10,
              padding: "12px 13px",
              fontFamily: "Inter",
              fontSize: 12,
              lineHeight: 1.5,
              color: "#6B6560",
            }}
          >
            No scores here. After each answer you get the interviewer&apos;s read — what they heard, and how to say it better.
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
  if (m.role === "interviewer") {
    return (
      <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "#2B2822",
            color: "#FAF8F6",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {job.mono}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {m.label && (
            <div className="ds-mono-9" style={{ color: m.labelColor ?? "#A66A00", marginBottom: 6 }}>
              {m.label}
            </div>
          )}
          <div
            style={{
              background: "#FFFFFF",
              border: "1px solid #EDE8DF",
              borderRadius: 13,
              padding: "13px 16px",
              fontFamily: "Inter",
              fontSize: 14.5,
              lineHeight: 1.55,
              color: "#2B2822",
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
      <div style={{ display: "flex", gap: 11, alignItems: "flex-start", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: 480,
            background: "#5D3000",
            color: "#FAF8F6",
            borderRadius: 13,
            padding: "13px 16px",
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
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "#E8DCCA",
            color: "#5D3000",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: 13,
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
          marginLeft: 46,
          maxWidth: 560,
          background: "#FFFFFF",
          border: "1px solid #E8DCCA",
          borderRadius: 13,
          overflow: "hidden",
          boxShadow: "0 1px 2px rgba(0,0,0,.04)",
        }}
      >
        <div
          style={{
            background: "#FBF8F3",
            borderBottom: "1px solid #EDE8DF",
            padding: "9px 15px",
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#A66A00" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
            <circle cx={12} cy={12} r={3} />
          </svg>
          <span className="ds-mono-9" style={{ color: "#A66A00" }}>WHAT THE INTERVIEWER HEARD</span>
        </div>
        <div style={{ padding: 15, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="ds-mono-9" style={{ color: "#A39F99", marginBottom: 4 }}>YOU SAID</div>
            <div className="ds-body-sm" style={{ fontSize: 13.5, color: "#6B6560", fontStyle: "italic" }}>
              “{fb.said}”
            </div>
          </div>
          <div style={{ background: "#FBF8F3", border: "1px solid #EDE8DF", borderRadius: 9, padding: "11px 13px" }}>
            <div className="ds-mono-9" style={{ color: "#A66A00", marginBottom: 4 }}>WHAT THEY HEARD</div>
            <div className="ds-body-sm" style={{ fontSize: 13.5 }}>{fb.heard}</div>
          </div>
          <div style={{ background: "#EBF3E5", border: "1px solid #cfe3c2", borderRadius: 9, padding: "11px 13px" }}>
            <div className="ds-mono-9" style={{ color: "#4C7A3F", marginBottom: 4 }}>TRY INSTEAD</div>
            <div className="ds-body-sm" style={{ fontSize: 13.5, color: "#2d4a25" }}>{fb.rephrase}</div>
          </div>
          {fb.stuck && (
            <div style={{ display: "flex", gap: 9, alignItems: "flex-start", borderTop: "1px solid #EDE8DF", paddingTop: 11 }}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#A23A2E" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                <path d="M12 9v4M12 17h.01" />
                <circle cx={12} cy={12} r={10} />
              </svg>
              <div className="ds-body-sm" style={{ fontSize: 13, color: "#7a3b32" }}>{fb.stuck}</div>
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
          marginLeft: 46,
          maxWidth: 520,
          background: "#FFFBF4",
          border: "1px solid #E8DCCA",
          borderRadius: 11,
          padding: "13px 16px",
        }}
      >
        <div className="ds-mono-9" style={{ color: "#A66A00", marginBottom: 5 }}>COACH</div>
        <div className="ds-body-sm" style={{ fontSize: 13.5, color: "#3a352e" }}>{m.text}</div>
      </div>
    );
  }
  return null;
}

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
        padding: "40px 32px 64px",
        background: "radial-gradient(120% 80% at 50% 0%, #FFFDFB 0%, #FAF8F6 60%)",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto" }} className="animate-fade-up">
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#4C7A3F" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <path d="M22 4L12 14.01l-3-3" />
          </svg>
          <span className="ds-mono-11" style={{ color: "#4C7A3F" }}>SESSION COMPLETE</span>
        </div>
        <h1 className="ds-h1" style={{ margin: "0 0 10px" }}>Your interview card.</h1>
        <p className="ds-body-md" style={{ fontSize: 15, color: "#6B6560", margin: "0 0 22px" }}>
          How each answer read from the other side of the table — and what to carry into the real round.
        </p>

        <div className="ds-card" style={{ overflow: "hidden", marginBottom: 18 }}>
          {MOCK_PROGRESS_LABELS.map((topic, i) => {
            const tags = [
              { label: "Sharp", color: "#4C7A3F", bg: "#EBF3E5" },
              { label: "Solid", color: "#5D3000", bg: "#F5EDE3" },
              { label: "Watch", color: "#A66A00", bg: "#F8ECD6" },
              { label: "Solid", color: "#5D3000", bg: "#F5EDE3" },
              { label: "Sharp", color: "#4C7A3F", bg: "#EBF3E5" },
            ];
            const t = tags[i] ?? tags[0];
            return (
              <div
                key={topic}
                style={{
                  padding: "15px 18px",
                  borderBottom: i === MOCK_PROGRESS_LABELS.length - 1 ? "none" : "1px solid #F1ECE3",
                  display: "flex",
                  gap: 14,
                  alignItems: "flex-start",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: "#2B2822", marginBottom: 3 }}>
                    {topic}
                  </div>
                  <div className="ds-body-sm" style={{ fontSize: 13, color: "#6B6560" }}>
                    Read as confident; could land the decision earlier.
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: 10,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                    color: t.color,
                    background: t.bg,
                    padding: "3px 9px",
                    borderRadius: 5,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.label}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ background: "#F5EDE3", border: "1px solid #E8DCCA", borderRadius: 13, padding: "18px 20px", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#5D3000" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 3 3 5-6" />
            </svg>
            <span className="ds-mono-10" style={{ color: "#5D3000" }}>CLOSE THE LOOP</span>
          </div>
          <div className="ds-body-sm" style={{ fontSize: 14, lineHeight: 1.6, color: "#3a352e", marginBottom: 13 }}>
            After the real {job.co} screen, come back and log what they actually asked. Vantage learns your real weak spots — not generic advice.
          </div>
          <button
            style={{
              cursor: "pointer",
              border: "1px solid #D6CEC0",
              background: "#FFFFFF",
              color: "#2B2822",
              fontFamily: "Inter",
              fontWeight: 600,
              fontSize: 13,
              padding: "10px 16px",
              borderRadius: 9,
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Log the real interview
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "#221E18",
            borderRadius: 13,
            padding: "16px 20px",
            marginBottom: 22,
          }}
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#e8a317" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M13 2L3 14h7l-1 8 10-12h-7z" />
          </svg>
          <div style={{ flex: 1, fontFamily: "Inter", fontSize: 14, lineHeight: 1.5, color: "#e6ddd0" }}>
            Next time, we&apos;ll open on your weak spots:{" "}
            <b style={{ color: "#FAF8F6", fontWeight: 600 }}>{focusNext}</b>.
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={onRestart} style={secondaryBtnStyle()}>Run it again</button>
          <button onClick={onDone} style={primaryBtnStyle({ flex: 1.4 })}>Done</button>
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
    fontSize: 14,
    color: "#6B6560",
    padding: "6px 4px",
    marginBottom: 18,
  };
}

function modeCardStyle(selected: boolean): React.CSSProperties {
  return {
    cursor: "pointer",
    textAlign: "left",
    background: selected ? "#FFFDFB" : "#FFFFFF",
    border: `1px solid ${selected ? "#5D3000" : "#EDE8DF"}`,
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 1px 2px rgba(0,0,0,.04)",
    transition: "all .14s",
  };
}

function primaryBtnStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    width: "100%",
    marginTop: 20,
    cursor: "pointer",
    border: "none",
    background: "#5D3000",
    color: "#FAF8F6",
    fontFamily: "Inter",
    fontWeight: 600,
    fontSize: 16,
    padding: 15,
    borderRadius: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    ...extra,
  };
}

function secondaryBtnStyle(): React.CSSProperties {
  return {
    flex: 1,
    cursor: "pointer",
    border: "1px solid #D6CEC0",
    background: "#FFFFFF",
    color: "#2B2822",
    fontFamily: "Inter",
    fontWeight: 600,
    fontSize: 14,
    padding: 14,
    borderRadius: 11,
  };
}

function iconBtnStyleInk(): React.CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    color: "#6B6560",
    padding: 4,
  };
}

function sendBtnStyle(): React.CSSProperties {
  return {
    cursor: "pointer",
    border: "none",
    background: "#5D3000",
    width: 34,
    height: 34,
    borderRadius: 9,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}
