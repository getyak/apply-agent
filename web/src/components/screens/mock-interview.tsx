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
import { useDock } from "@/lib/ask-vantage-store";
import { sendAsk } from "@/lib/ask-stream";
import { users as usersApi } from "@/lib/api";
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

// Mock-local palette. Mock studio renders against a neutral grayscale system
// (Linear/Vercel-leaning), distinct from the workspace's warm cream paper.
// Keep this private to mock-interview.tsx — the rest of Vantage stays on the
// shared design tokens in globals.css. Single accent color `gold` is reused
// from the brand to keep CTAs visually connected to the rest of the product.
const M = {
  paper: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceAlt: "#F5F5F5",
  ink: "#0A0A0A",
  body: "#525252",
  muted: "#A3A3A3",
  border: "#E5E5E5",
  borderStrong: "#D4D4D4",
  borderInk: "#0A0A0A",
  accent: "#e8a317", // brand gold — reserved for state pills (LIVE / FOLLOW-UP)
  accentInkOnAccent: "#0A0A0A",
  danger: "#B91C1C", // muted red, used only for THE TRAP banner
  dangerBg: "#FEF2F2",
  dangerBorder: "#FECACA",
} as const;

function intelLabel(s: IntelStrategy): string {
  return s === "none"
    ? "NO INTEL"
    : s === "jd_based"
      ? "JD INTEL"
      : s === "crowdsourced"
        ? "CROWD INTEL"
        : "RECRUITER INTEL";
}

function pressureLabel(p: PressureLevel): string {
  return p === "encourage_only"
    ? "LOW"
    : p === "one_follow_up"
      ? "MED"
      : "HIGH";
}

function feedbackLabel(f: FeedbackStyle): string {
  return f === "rating_1to5"
    ? "1–5 RATING"
    : f === "one_line_per_answer"
      ? "ONE-LINE"
      : "3 PERSPECTIVE";
}

function loopLabel(l: LoopBehavior): string {
  return l === "standalone"
    ? "STANDALONE"
    : l === "save_to_card"
      ? "SAVE CARD"
      : "REPLAY REAL";
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
  feedback?: TranslationFeedback;
}

export function MockScreen() {
  const backHome = useVantage((s) => s.backHome);
  const apiApplications = useVantage((s) => s.apiApplications);
  const currentUser = useVantage((s) => s.currentUser);
  const parsedResume = useVantage((s) => s.parsedResume);

  const [stage, setStage] = useState<Stage>("modes");
  const [selectedSlug, setSelectedSlug] = useState<string>("scene_recreation");
  const [qIdx, setQIdx] = useState(0);
  const [messages, setMessages] = useState<MockMessage[]>([]);
  const [pendingAnswer, setPendingAnswer] = useState<string>("");
  // HITL gate — agent-harness.md §HITL requires an explicit-go before any
  // session that holds the user's attention. Live mock is a 10–25 min
  // commitment, so we always interrupt with a confirm modal before the
  // stage flips to "live". The modal carries duration / question count /
  // mode name so the user knows what they're opting into.
  const [pendingStart, setPendingStart] = useState(false);

  // Immersive live stage — collapse the dock to its 54px launcher per
  // vantage-ui-mapping.md §3.6 ("进 live 阶段：dock 自动收起到 54px
  // launcher"). modes / intel / debrief stages keep the dock available so
  // the user can still ask Vantage to refine their answer between rounds.
  // Cleanup restores the dock when leaving the mock screen or on crash.
  useEffect(() => {
    if (stage === "live") {
      useDock.getState().setHintedCollapse(true);
    } else {
      useDock.getState().setHintedCollapse(false);
    }
  }, [stage]);
  useEffect(() => {
    return () => {
      useDock.getState().setHintedCollapse(false);
    };
  }, []);

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

  // Same precedence as sidebar/dock: prefer the résumé's basics.name over
  // auth display_name so the avatar never falls back to the email's first
  // letter (QA bug #5).
  const initials = initialsOf(
    parsedResume?.basics?.name?.trim() || currentUser?.displayName?.trim() || "",
  );

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
      // No intel page to read — go straight to the HITL confirm.
      setPendingStart(true);
    } else {
      setStage("intel");
    }
  }

  function beginLive() {
    // After reading the intel brief, still require an explicit-go before
    // entering the timed live stage.
    setPendingStart(true);
  }

  function confirmStart() {
    setPendingStart(false);
    seedFirstQuestion();
    setStage("live");
  }

  function cancelStart() {
    setPendingStart(false);
  }

  function seedFirstQuestion() {
    const first = MOCK_QS[0];
    setMessages([
      {
        role: "interviewer",
        text: first.q,
        label: "OPENING",
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
        {pendingStart && (
          <StartConfirmModal
            mode={selectedMode}
            questionCount={MOCK_QS.length}
            onCancel={cancelStart}
            onConfirm={confirmStart}
          />
        )}
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
        {pendingStart && (
          <StartConfirmModal
            mode={selectedMode}
            questionCount={MOCK_QS.length}
            onCancel={cancelStart}
            onConfirm={confirmStart}
          />
        )}
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
        background: M.paper,
        color: M.ink,
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
  const selected = modes.find((x) => x.slug === selectedSlug);
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "48px 32px 80px",
        background: M.paper,
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }} className="animate-fade-up">
        <button onClick={onBack} style={ghostBtnStyle()}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Back
        </button>

        {/* For-line: who you're practising for. Mono, one line, left-aligned. */}
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
          For · {job.co} · {job.role} · {job.stage}
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

        {/* Single-column mode list. Each card carries the 4-dimension mono row
            (ANCHOR / PRESSURE / FEEDBACK / LOOP) — those four slots ARE the
            mode (vantage-ui-mapping.md §3.1), so they belong on every card. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {modes.map((m) => {
            const isSel = m.slug === selectedSlug;
            return (
              <button
                key={m.slug}
                onClick={() => onPick(m.slug)}
                style={modeCardStyle(isSel)}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "Inter",
                      fontWeight: 600,
                      fontSize: 17,
                      color: M.ink,
                    }}
                  >
                    {m.name}
                  </span>
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      border: `1px solid ${isSel ? M.ink : M.borderStrong}`,
                      background: isSel ? M.ink : "transparent",
                      flexShrink: 0,
                    }}
                  />
                </div>
                <div
                  style={{
                    fontFamily: "Inter",
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: M.body,
                    marginBottom: 14,
                  }}
                >
                  {m.tagline}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "6px 14px",
                    fontFamily: "JetBrains Mono",
                    fontSize: 10.5,
                    letterSpacing: 0.6,
                    color: M.muted,
                  }}
                >
                  <span>ANCHOR · {intelLabel(m.intel)}</span>
                  <span>PRESSURE · {pressureLabel(m.pressure)}</span>
                  <span>FEEDBACK · {feedbackLabel(m.feedback)}</span>
                  <span>LOOP · {loopLabel(m.loop)}</span>
                </div>
              </button>
            );
          })}
        </div>

        <button onClick={onStart} style={primaryBtnStyle()}>
          Start{selected ? ` · ${selected.name}` : ""}
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={M.surface} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
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
        padding: "48px 32px 80px",
        background: M.paper,
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto" }} className="animate-fade-up">
        <button onClick={onBack} style={ghostBtnStyle()}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Modes
        </button>
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
          Intel brief · {job.co} · {job.stage}
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
          What this round actually asks.
        </h1>
        <p style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 1.55, color: M.body, margin: "0 0 32px" }}>
          Pulled from the crowd-sourced question bank and public signals. We drill the likely ones first.
        </p>

        {/* Round summary — bordered card, no fills. */}
        <div
          style={{
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderRadius: 10,
            padding: "16px 18px",
            marginBottom: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 15, color: M.ink }}>
              {job.stage}
            </span>
            <span
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: 10,
                letterSpacing: 0.6,
                color: M.muted,
                border: `1px solid ${M.border}`,
                padding: "2px 8px",
                borderRadius: 4,
              }}
            >
              {intel.duration}
            </span>
          </div>
          <div style={{ fontFamily: "Inter", fontSize: 14, lineHeight: 1.6, color: M.body }}>
            {intel.style}
          </div>
        </div>

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
      {/* Top bar: minimal — back, role/co, progress pill. */}
      <div
        style={{
          height: 56,
          flexShrink: 0,
          borderBottom: `1px solid ${M.border}`,
          background: M.surface,
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          gap: 14,
        }}
      >
        <button onClick={onBack} style={iconBtnStyleInk()} aria-label="Exit mock">
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: M.ink }}>
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

      {/* Single-column immersive Q/A. No right rail. */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: M.paper }}>
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 0 12px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 40px", display: "flex", flexDirection: "column", gap: 22 }}>
            {messages.map((m, i) => (
              <MessageBlock key={i} m={m} job={job} initials={initials} />
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
  // P3.3 flywheel entry. Opens the opt-in modal on first click; once the
  // user confirms (or declines) the modal's choice is persisted to
  // preferences.crowdsourceOptIn so we never re-prompt on later sessions.
  const [logRealOpen, setLogRealOpen] = useState(false);
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
            onClick={() => setLogRealOpen(true)}
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
        {logRealOpen ? (
          <LogRealInterviewModal
            company={job.co}
            onClose={() => setLogRealOpen(false)}
          />
        ) : null}

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

// ─── Log-real-interview opt-in modal (P3.3) ─────────────────────────
//
// Two paths out of this modal:
//
//   1. "Just for me" — keeps everything local to the user's account.
//      We still hand control to Ask Vantage so it can prompt the user
//      through what actually got asked, but we do NOT toggle
//      crowdsourceOptIn on (it stays at its current value).
//
//   2. "Yes, help the pool" — same Vantage hand-off, AND we PATCH the
//      user's preferences.crowdsourceOptIn = true so subsequent
//      sessions know they may anonymise + donate to the question pool
//      (vantage-ui-mapping.md §3.5).
//
// Either way the closing action opens the dock and seeds a prompt so
// the user lands in conversation, not a blank screen. The persistence
// failure is intentionally silent — the dock conversation is the
// primary outcome; a 4xx on the prefs PATCH (e.g. network blip) must
// not block the user from logging the real interview.
function LogRealInterviewModal({
  company,
  onClose,
}: {
  company: string;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function persistAndHandoff(optIn: boolean) {
    setSaving(true);
    try {
      if (optIn) {
        try {
          await usersApi.updateMe({ crowdsourceOptIn: true });
        } catch (err) {
          // Non-fatal — see comment above. We still hand off below.
          console.warn("[mock] crowdsource opt-in patch failed:", err);
        }
      }
      useDock.getState().open();
      void sendAsk(
        `I just finished the real ${company} interview. Let's log the actual questions they asked so Vantage can sharpen my next prep.`,
        [],
        { surface: "dock" },
      );
    } finally {
      setSaving(false);
      onClose();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(43, 40, 34, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: M.surface,
          border: `1px solid ${M.border}`,
          borderRadius: 14,
          maxWidth: 520,
          width: "100%",
          padding: 28,
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        }}
        className="animate-fade-up"
      >
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 10.5,
            letterSpacing: 1,
            color: M.muted,
            marginBottom: 10,
            textTransform: "uppercase",
          }}
        >
          Privacy first
        </div>
        <h2
          style={{
            fontFamily: "Inter",
            fontWeight: 600,
            fontSize: 22,
            lineHeight: 1.25,
            color: M.ink,
            margin: "0 0 10px",
          }}
        >
          Log what {company} actually asked
        </h2>
        <p
          style={{
            fontFamily: "Inter",
            fontSize: 14.5,
            lineHeight: 1.6,
            color: M.body,
            margin: "0 0 14px",
          }}
        >
          We&apos;ll open Ask Vantage so you can walk through the real round
          while it&apos;s fresh. Pick one — you can change it later in Settings.
        </p>
        <ul
          style={{
            fontFamily: "Inter",
            fontSize: 13,
            lineHeight: 1.65,
            color: M.body,
            margin: "0 0 22px",
            padding: "0 0 0 20px",
          }}
        >
          <li>
            <b style={{ fontWeight: 600 }}>Just for me</b> — questions stay
            on your account. We never share or aggregate them.
          </li>
          <li>
            <b style={{ fontWeight: 600 }}>Help the pool</b> — same as above,
            plus we anonymise the questions (no name, no company, no role
            details) and add them to a shared bank so others get a closer
            mock next time. You can opt out any time.
          </li>
        </ul>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => persistAndHandoff(false)}
            disabled={saving}
            style={{
              ...secondaryBtnStyle(),
              opacity: saving ? 0.6 : 1,
              cursor: saving ? "wait" : "pointer",
            }}
          >
            Just for me
          </button>
          <button
            onClick={() => persistAndHandoff(true)}
            disabled={saving}
            style={{
              ...primaryBtnStyle({ marginTop: 0, flex: 1 }),
              opacity: saving ? 0.6 : 1,
              cursor: saving ? "wait" : "pointer",
            }}
          >
            Yes, help the pool
          </button>
        </div>
        <button
          onClick={onClose}
          disabled={saving}
          style={{
            ...ghostBtnStyle(),
            marginTop: 14,
            width: "100%",
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
