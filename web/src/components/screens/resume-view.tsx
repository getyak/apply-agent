"use client";

// Résumé view — vibe chat (left) + document + version timeline (right).
// Per docs/architecture/vantage-ui-mapping.md §2 (rev. 2026-06-18):
//   Resume Studio carries its own document-scoped vibe chat. The Ask
//   Vantage dock remains the cross-surface lifetime conversation; the
//   vibe chat is per-résumé-branch and shares the /api/ask/stream
//   plumbing via runAskStream + useConversationStream.
// Vantage.dc.html lines 392–583 are the visual contract for the
// document pane.
//
// We mount it under /app/studio/resume. The Builder overlay (the old
// chat-driven "build from scratch" flow) remains separately reachable.

import { useEffect, useMemo, useRef, useState } from "react";
import { resumes as resumesApi } from "@/lib/api";
import { useDock } from "@/lib/ask-vantage-store";
import { useVantage } from "@/lib/store";
import { useConversationStream } from "@/lib/use-conversation-stream";
import {
  VibeChatPanel,
  type VibeChip,
} from "@/components/studio/vibe-chat-panel";

type VersionRow = {
  id: string;
  version: number;
  isBase: boolean;
  createdAt: string;
};

interface JsonResumeBasics {
  name?: string;
  label?: string;
  email?: string;
  phone?: string;
  location?: { city?: string; region?: string };
  summary?: string;
}

interface JsonResumeWork {
  name?: string;
  position?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  highlights?: string[];
}

interface JsonResumeSkill {
  name?: string;
  keywords?: string[];
}

interface JsonResumeEducation {
  institution?: string;
  area?: string;
  studyType?: string;
  startDate?: string;
  endDate?: string;
}

interface JsonResume {
  basics?: JsonResumeBasics;
  work?: JsonResumeWork[];
  skills?: JsonResumeSkill[];
  education?: JsonResumeEducation[];
  // Metadata threaded through by api/src/routes/resumes.ts::unwrapResumeRow.
  // Empty array (or undefined) means a clean parse. Populated means "AI couldn't
  // structure these bits — would you like help filling them in?" via the banner.
  _warnings?: string[];
  _raw?: string;
  _parsedAt?: string | null;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d
    .toLocaleDateString(undefined, { day: "2-digit", month: "short" })
    .toUpperCase();
}

function summarizeChange(v: VersionRow): string {
  if (v.isBase) return "Your master résumé.";
  return "Tailored variant — branched from master.";
}

function VantageMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#FAF8F6"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 2.5l1.7 4.6 4.9.2-3.8 3 1.3 4.7-4-2.8-4 2.8 1.3-4.7-3.8-3 4.9-.2z" />
    </svg>
  );
}

export function ResumeView() {
  const currentResumeId = useVantage((s) => s.currentResumeId);
  const currentUser = useVantage((s) => s.currentUser);
  // Async parse pipeline state — owned by the global store so the workspace
  // banner and this view stay in lockstep (one source of truth for "what
  // file are we parsing right now").
  const parseFile = useVantage((s) => s.parseFile);
  const parseJobStatus = useVantage((s) => s.parseJobStatus);
  const parseJobProgress = useVantage((s) => s.parseJobProgress);
  const parseJobError = useVantage((s) => s.parseJobError);
  const parseFileName = useVantage((s) => s.parseFileName);
  const parseError = useVantage((s) => s.parseError);
  const dismissParseBanner = useVantage((s) => s.dismissParseBanner);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [vibeInput, setVibeInput] = useState("");

  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<JsonResume | null>(null);
  // Diff base: the master résumé content. We lazy-load it on first
  // compare-mode entry against a tailored variant; the master itself
  // has nothing to diff against, so we leave this null otherwise.
  const [baseDoc, setBaseDoc] = useState<JsonResume | null>(null);
  const [baseDocLoading, setBaseDocLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [compareOn, setCompareOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (alive) setLoading(true);
    });
    resumesApi
      .list()
      .then((res) => {
        if (!alive) return;
        type Row = { id: string; version: number; is_base: boolean; created_at: string };
        const rows =
          (res as { data?: Row[]; resumes?: Row[] }).data ??
          (res as { resumes?: Row[] }).resumes ??
          [];
        const mapped: VersionRow[] = rows
          .map((r) => ({
            id: r.id,
            version: r.version,
            isBase: Boolean(r.is_base),
            createdAt: r.created_at,
          }))
          .sort((a, b) => b.version - a.version);
        setVersions(mapped);
        const initial =
          currentResumeId ?? mapped.find((r) => r.isBase)?.id ?? mapped[0]?.id ?? null;
        setSelectedId(initial);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [currentResumeId]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    resumesApi
      .get(selectedId)
      .then((res) => {
        if (!alive) return;
        const r = res as { resume?: { content?: JsonResume } };
        setDoc(r.resume?.content ?? null);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const currentVersion = useMemo(
    () => versions.find((v) => v.id === selectedId) ?? null,
    [versions, selectedId],
  );
  const masterVersions = useMemo(() => versions.filter((v) => v.isBase), [versions]);
  const tailoredVariants = useMemo(() => versions.filter((v) => !v.isBase), [versions]);

  // The diff base is the most-recent master version. (Once the API exposes
  // resumes.parent_version, switch to following that pointer — for now the
  // most-recent master is a faithful stand-in.)
  const baseVersionId = useMemo(() => masterVersions[0]?.id ?? null, [masterVersions]);
  const tailoredAgainstBase =
    compareOn && currentVersion != null && !currentVersion.isBase && baseVersionId != null;

  useEffect(() => {
    let alive = true;
    if (!tailoredAgainstBase || !baseVersionId) {
      queueMicrotask(() => {
        if (alive) setBaseDoc(null);
      });
      return () => {
        alive = false;
      };
    }
    queueMicrotask(() => {
      if (alive) setBaseDocLoading(true);
    });
    resumesApi
      .get(baseVersionId)
      .then((res) => {
        if (!alive) return;
        const r = res as { resume?: { content?: JsonResume } };
        setBaseDoc(r.resume?.content ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setBaseDoc(null);
      })
      .finally(() => {
        if (alive) setBaseDocLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tailoredAgainstBase, baseVersionId]);

  function askToTailor() {
    const dock = useDock.getState();
    dock.open();
    dock.setInput("Tailor this résumé for a new role — ");
  }

  // "Help me fill the gaps" CTA from the parse-warnings banner. Drops the
  // user into the dock with a focused prompt that hands the AI the list of
  // things to ask about, plus the raw text so it has something to work from.
  function askToFillGaps(warnings: string[], rawText: string | undefined) {
    const dock = useDock.getState();
    dock.open();
    const wlist = warnings.map((w, i) => `${i + 1}. ${w}`).join("\n");
    const rawSnippet = rawText
      ? `\n\nHere's the resume text I uploaded:\n\n${rawText.slice(0, 4_000)}`
      : "";
    dock.setInput(
      `My résumé parse left a few gaps. Please ask me one question at a time so we can fill them in:\n\n${wlist}${rawSnippet}`,
    );
  }

  // The header "Upload new" button and the no-résumé empty state both fire
  // the hidden <input type="file">. Going straight to the OS picker keeps
  // the parse-on-upload contract honest — we never *say* "uploaded" before
  // a file is actually selected. The Dock prompt path stays as a fallback
  // for users who'd rather talk through the upload.
  function askToUpload() {
    fileInputRef.current?.click();
  }

  function tellDockAboutUpload() {
    const dock = useDock.getState();
    dock.open();
    dock.setInput("I want to upload a new résumé.");
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    // Reset the input so picking the same file twice still fires onChange.
    e.target.value = "";
    if (!f) return;
    await parseFile(f);
  }

  function exportResume() {
    if (!doc) return;
    const blob = new Blob([JSON.stringify(doc, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resume-v${currentVersion?.version ?? "current"}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─── Vibe chat (vantage-ui-mapping.md §2.6) ────────────────────────────
  //
  // The thread id is per-master-résumé, so every tailored variant of the
  // same master shares the conversation — the user thinks "this résumé",
  // not "this version".
  //
  // resumeRootId resolution: when the user is viewing a tailored variant,
  // we route to the most-recent master id (matches the existing diff base
  // logic). For a master, the master's own id is the root. When nothing is
  // viewable yet (initial load / empty state) the thread is null and the
  // panel sits inert — clicking a chip is a no-op until the data arrives.
  const resumeRootId = useMemo(() => {
    if (!currentVersion) return null;
    if (currentVersion.isBase) return currentVersion.id;
    return masterVersions[0]?.id ?? currentVersion.id;
  }, [currentVersion, masterVersions]);

  const vibeThreadId = useMemo(() => {
    if (!currentUser || !resumeRootId) return null;
    return `resume_studio:${currentUser.id}:${resumeRootId}`;
  }, [currentUser, resumeRootId]);

  const vibeChat = useConversationStream({
    threadId: vibeThreadId,
    surface: "resume_studio",
    resetKey: vibeThreadId,
  });

  // Chip handlers. Each prepares a focused prompt that primes the
  // conversation; sending happens through the same vibeChat.send() so
  // SSE results land in this panel, not the dock.
  function sendChip(prompt: string) {
    void vibeChat.send(prompt);
  }

  const vibeChips: VibeChip[] = useMemo(() => {
    const disabled = vibeChat.streaming || !vibeThreadId;
    return [
      {
        id: "optimize",
        label: "优化建议",
        hint: "Analyze the current résumé and surface the top 3 weakest spots.",
        disabled,
        onActivate: () =>
          sendChip(
            "Analyze this résumé and tell me the three weakest spots — be specific about which bullet or section, and what to change.",
          ),
      },
      {
        id: "tailor",
        label: "JD 微调",
        hint: "Tailor this résumé for a job description.",
        disabled,
        onActivate: () =>
          sendChip(
            "I want to tailor this résumé for a specific role. Ask me to paste the JD, then customize the bullets to match — without inventing experience I don't have.",
          ),
      },
      {
        id: "plan",
        label: "职业规划",
        hint: "Read the trajectory and map the next 1–2 moves.",
        disabled,
        onActivate: () =>
          sendChip(
            "Read my résumé's trajectory and tell me what the next one or two career moves should look like, plus which skills I'd need to close to get there.",
          ),
      },
      {
        id: "recommend",
        label: "职业推荐",
        hint: "Surface jobs that match the current résumé.",
        disabled,
        onActivate: () =>
          sendChip(
            "Based on this résumé, suggest five roles that would be a strong match right now — and explain in one line why each fits.",
          ),
      },
    ];
    // sendChip closes over vibeChat which changes per render; we accept
    // the new identities — chips are cheap to recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vibeChat.streaming, vibeThreadId]);

  // withVibeChat wraps every render branch (loading / error / empty / main)
  // in the left-vibe-chat + right-content two-pane shell so the chat panel
  // is always present once we know who the user is.
  function withVibeChat(content: React.ReactNode): React.ReactNode {
    // While currentUser is still loading we don't have a thread id yet;
    // render the content full-width rather than flashing a dead panel.
    if (!currentUser) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: "#FAF8F6",
          }}
        >
          {content}
        </div>
      );
    }
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "row",
          background: "#FAF8F6",
          minHeight: 0,
        }}
      >
        <VibeChatPanel
          title={
            currentVersion?.isBase
              ? "Sharpen your master résumé"
              : currentVersion
                ? "Refine this résumé"
                : "Start with your résumé"
          }
          subtitle="Scoped to this résumé — picks up your version, your context, every time."
          chips={vibeChips}
          messages={vibeChat.messages}
          agentEvents={vibeChat.agentEvents}
          streaming={vibeChat.streaming}
          input={vibeInput}
          onInputChange={setVibeInput}
          onSend={() => {
            const t = vibeInput.trim();
            if (!t) return;
            setVibeInput("");
            void vibeChat.send(t);
          }}
          onCancel={() => vibeChat.cancel()}
        />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {content}
        </div>
      </div>
    );
  }

  // Hidden file input + parse banner are needed on every render branch
  // (loading / error / empty / main), so we lift them into one shared
  // pre-render block reused by each early return.
  const sharedChrome = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.md,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
        onChange={onFileChosen}
        className="hidden"
        aria-hidden="true"
      />
      <ParseProgressBanner
        status={parseJobStatus}
        progress={parseJobProgress}
        fileName={parseFileName}
        error={parseError ?? parseJobError}
        onDismiss={dismissParseBanner}
        onTellDock={tellDockAboutUpload}
        onRetry={askToUpload}
      />
    </>
  );

  if (loading) {
    return withVibeChat(
      <>
        {sharedChrome}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="ds-mono-10">LOADING RÉSUMÉ…</span>
        </div>
      </>,
    );
  }

  if (error && versions.length === 0) {
    return withVibeChat(
      <>
        {sharedChrome}
        <div style={{ padding: 32 }}>
          <div className="ds-card" style={{ padding: 22, maxWidth: 540 }}>
            <div className="ds-headline-caps" style={{ color: "#A23A2E", marginBottom: 8 }}>
              COULDN&apos;T LOAD RÉSUMÉ
            </div>
            <p className="ds-body-sm">{error}</p>
          </div>
        </div>
      </>,
    );
  }

  if (versions.length === 0 || !doc) {
    return withVibeChat(
      <>
        {sharedChrome}
        <div style={{ padding: 32 }}>
          <div className="ds-card" style={{ padding: 28, maxWidth: 540 }}>
            <div className="ds-headline-caps" style={{ marginBottom: 8 }}>NO RÉSUMÉ YET</div>
            <p className="ds-body-sm" style={{ marginBottom: 18 }}>
              Upload one, or build one by talking to Vantage.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={askToUpload}
                style={{
                  cursor: "pointer",
                  border: "none",
                  background: "#5D3000",
                  color: "#FAF8F6",
                  padding: "12px 18px",
                  borderRadius: 10,
                  fontFamily: "Inter",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                Upload a file
              </button>
              <button
                onClick={tellDockAboutUpload}
                style={{
                  cursor: "pointer",
                  border: "1px solid #D6CEC0",
                  background: "#FFFFFF",
                  color: "#2B2822",
                  padding: "12px 18px",
                  borderRadius: 10,
                  fontFamily: "Inter",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                Talk it through with Vantage
              </button>
            </div>
          </div>
        </div>
      </>,
    );
  }

  const basics = doc.basics ?? {};
  const contact = [basics.email, basics.phone, [basics.location?.city, basics.location?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" · ");

  return withVibeChat(
    <>
      {sharedChrome}
      <div
        className="ds-backdrop"
        style={{
          height: 60,
          flexShrink: 0,
          borderBottom: "1px solid #EDE8DF",
          display: "flex",
          alignItems: "center",
          gap: 13,
          padding: "0 22px",
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "#F3F0EB",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#5D3000" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M9 13h6M9 17h4" />
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 14, color: "#2B2822", lineHeight: 1.15 }}>
            {currentVersion?.isBase ? "Master résumé" : "Tailored variant"}
          </div>
          <div className="ds-mono-10">
            VERSION {currentVersion?.version ?? "—"} · {currentVersion ? relativeTime(currentVersion.createdAt) : ""}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 11 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "JetBrains Mono",
              fontSize: 10,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: "#4C7A3F",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "#4C7A3F" }} />
            Saved
          </span>
          <button onClick={() => setCompareOn((v) => !v)} style={chromeBtnStyle(compareOn)}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v18" />
              <path d="M5 7l-2 2 2 2M19 7l2 2-2 2" />
              <path d="M3 9h6M15 9h6" />
            </svg>
            {compareOn ? "Exit compare" : "Compare"}
          </button>
          <button onClick={askToUpload} style={chromeBtnStyle(false)}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4M6 10l6-6 6 6" />
              <path d="M4 20h16" />
            </svg>
            Upload new
          </button>
          <button onClick={exportResume} style={chromeBtnStyle(false)}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5M12 15V3" />
            </svg>
            Export
          </button>
        </div>
      </div>

      {doc?._warnings && doc._warnings.length > 0 ? (
        <ParseWarningsBanner
          warnings={doc._warnings}
          onAsk={() => askToFillGaps(doc._warnings ?? [], doc._raw)}
        />
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
        <VersionRail
          versions={masterVersions}
          variants={tailoredVariants}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setCompareOn(false);
          }}
          onTailorPrompt={askToTailor}
        />
        <DocumentPane
          basics={basics}
          contact={contact}
          work={doc.work ?? []}
          skills={doc.skills ?? []}
          education={doc.education ?? []}
          showAITouchedLabel={!currentVersion?.isBase}
          compareOn={compareOn}
          baseDoc={tailoredAgainstBase ? baseDoc : null}
          baseDocLoading={tailoredAgainstBase && baseDocLoading}
          baseVersionLabel={
            tailoredAgainstBase && masterVersions[0]
              ? `v${masterVersions[0].version}`
              : null
          }
        />
      </div>
    </>,
  );
}

function chromeBtnStyle(active: boolean): React.CSSProperties {
  return {
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: `1px solid ${active ? "#5D3000" : "#D6CEC0"}`,
    background: active ? "#F5EDE3" : "#FFFFFF",
    color: "#2B2822",
    fontFamily: "Inter",
    fontWeight: 600,
    fontSize: 13,
    padding: "8px 13px",
    borderRadius: 9,
    transition: "border-color .14s, background .14s",
  };
}

function VersionRail({
  versions,
  variants,
  selectedId,
  onSelect,
  onTailorPrompt,
}: {
  versions: VersionRow[];
  variants: VersionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTailorPrompt: () => void;
}) {
  return (
    <aside
      style={{
        width: 312,
        flexShrink: 0,
        borderRight: "1px solid #EDE8DF",
        background: "#FBF8F3",
        overflowY: "auto",
        padding: "24px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px", marginBottom: 6 }}>
        <span className="ds-label" style={{ color: "#6B6560" }}>VERSION HISTORY</span>
        <span className="ds-mono-10">{versions.length} SAVED</span>
      </div>
      <div className="ds-caption" style={{ padding: "0 6px 14px", color: "#A39F99" }}>
        Every change is kept. Open any point to view it, compare, or restore.
      </div>

      <div style={{ position: "relative", paddingLeft: 4 }}>
        {versions.map((v) => {
          const isCurrent = v.id === selectedId;
          return (
            <button
              key={v.id}
              onClick={() => onSelect(v.id)}
              style={railRowStyle(isCurrent)}
              onMouseEnter={(e) => {
                if (!isCurrent) e.currentTarget.style.background = "#F5EDE3";
              }}
              onMouseLeave={(e) => {
                if (!isCurrent) e.currentTarget.style.background = "transparent";
              }}
            >
              <div style={{ position: "relative", width: 13, flexShrink: 0, display: "flex", justifyContent: "center", paddingTop: 4 }}>
                <span
                  style={{
                    position: "absolute",
                    left: 6,
                    top: 14,
                    bottom: -16,
                    width: 1,
                    background: "#E2DACB",
                  }}
                />
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 999,
                    background: isCurrent ? "#5D3000" : "#FFFFFF",
                    border: `2px solid ${isCurrent ? "#5D3000" : "#D6CEC0"}`,
                    zIndex: 1,
                  }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontFamily: "JetBrains Mono", fontWeight: 500, fontSize: 12, color: "#2B2822" }}>
                    v{v.version}
                  </span>
                  <span className="ds-mono-10">{relativeTime(v.createdAt)}</span>
                  {isCurrent && (
                    <span
                      style={{
                        fontFamily: "JetBrains Mono",
                        fontSize: 8,
                        letterSpacing: 0.6,
                        textTransform: "uppercase",
                        color: "#FAF8F6",
                        background: "#4C7A3F",
                        padding: "2px 6px",
                        borderRadius: 4,
                      }}
                    >
                      Current
                    </span>
                  )}
                </div>
                <div className="ds-body-sm" style={{ fontSize: 12.5, color: "#3a352e", marginBottom: 7 }}>
                  {summarizeChange(v)}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px", margin: "26px 0 4px" }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: 10,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: "#6B6560",
          }}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#A66A00" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <circle cx={6} cy={6} r={3} />
            <circle cx={6} cy={18} r={3} />
            <path d="M6 9v6M18 6a3 3 0 0 1-3 3H9" />
            <circle cx={18} cy={6} r={3} />
          </svg>
          TAILORED VARIANTS
        </span>
        <span className="ds-mono-10">{variants.length}</span>
      </div>
      <div className="ds-caption" style={{ padding: "0 6px 12px", color: "#A39F99" }}>
        Branches off your master, tuned per role.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {variants.map((v) => (
          <button
            key={v.id}
            onClick={() => onSelect(v.id)}
            className="ds-card"
            style={{ cursor: "pointer", padding: 12, textAlign: "left", transition: "border-color .14s" }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#D6CEC0")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#EDE8DF")}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: "#F3F0EB",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "Space Grotesk",
                  fontWeight: 700,
                  fontSize: 13,
                  color: "#2B2822",
                  flexShrink: 0,
                }}
              >
                v{v.version}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 13, color: "#2B2822", lineHeight: 1.2 }}>
                  Tailored — v{v.version}
                </div>
                <div className="ds-mono-10">FROM MASTER · {relativeTime(v.createdAt)}</div>
              </div>
            </div>
            <div className="ds-body-sm" style={{ fontSize: 12, color: "#6B6560" }}>
              Summary, skills, or bullets reshaped for one role.
            </div>
          </button>
        ))}
        <button
          onClick={onTailorPrompt}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            border: "1px dashed #D6CEC0",
            background: "transparent",
            borderRadius: 11,
            padding: 12,
            cursor: "pointer",
            fontFamily: "Inter",
            fontWeight: 500,
            fontSize: 12.5,
            color: "#6B6560",
            transition: "all .14s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "#5D3000";
            e.currentTarget.style.color = "#5D3000";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "#D6CEC0";
            e.currentTarget.style.color = "#6B6560";
          }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Tailor for a new role
        </button>
      </div>

      <div style={{ marginTop: 26, padding: 14, background: "#FFFBF4", border: "1px solid #E8DCCA", borderRadius: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: "#5D3000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <VantageMark size={13} />
          </div>
          <span className="ds-mono-10" style={{ color: "#5D3000" }}>EDIT WITH VANTAGE</span>
        </div>
        <p className="ds-body-sm" style={{ fontSize: 12.5, color: "#6B6560", margin: 0 }}>
          Use the dock to refine, tailor, or rewrite. Vantage saves a new version every time.
        </p>
      </div>
    </aside>
  );
}

function railRowStyle(isCurrent: boolean): React.CSSProperties {
  return {
    display: "flex",
    gap: 11,
    width: "100%",
    background: isCurrent ? "#F5EDE3" : "transparent",
    border: "none",
    borderRadius: 10,
    padding: "10px 12px",
    cursor: "pointer",
    textAlign: "left",
    transition: "background .14s",
  };
}

// Tokenise a string into a flat list of comparable "segments" for the diff.
// We split on bullet boundaries and sentence-ish punctuation so a long
// summary still produces meaningful added/unchanged chunks instead of
// being treated as one monolithic blob.
function tokenise(text: string | undefined | null): string[] {
  if (!text) return [];
  return text
    .split(/(?<=[.;!?])\s+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildBaseHighlightSet(base: JsonResume | null): Set<string> {
  const acc = new Set<string>();
  if (!base) return acc;
  for (const w of base.work ?? []) {
    for (const h of w.highlights ?? []) {
      const t = h.trim();
      if (t) acc.add(t);
    }
    for (const seg of tokenise(w.summary)) acc.add(seg);
  }
  for (const seg of tokenise(base.basics?.summary)) acc.add(seg);
  return acc;
}

function buildBaseSkillSet(base: JsonResume | null): Set<string> {
  const acc = new Set<string>();
  if (!base) return acc;
  for (const s of base.skills ?? []) {
    if (s.name) acc.add(s.name);
    for (const k of s.keywords ?? []) acc.add(k);
  }
  return acc;
}

function DocumentPane({
  basics,
  contact,
  work,
  skills,
  education,
  showAITouchedLabel,
  compareOn,
  baseDoc,
  baseDocLoading,
  baseVersionLabel,
}: {
  basics: JsonResumeBasics;
  contact: string;
  work: JsonResumeWork[];
  skills: JsonResumeSkill[];
  education: JsonResumeEducation[];
  showAITouchedLabel: boolean;
  compareOn: boolean;
  baseDoc: JsonResume | null;
  baseDocLoading: boolean;
  baseVersionLabel: string | null;
}) {
  // diffOn = compare mode AND we have a base document to compare against.
  // Without a base (e.g. user is looking at master itself, or fetch failed)
  // we fall through to the same render path as non-diff mode.
  const diffOn = compareOn && baseDoc !== null;
  const baseHighlights = useMemo(
    () => (diffOn ? buildBaseHighlightSet(baseDoc) : new Set<string>()),
    [diffOn, baseDoc],
  );
  const baseSkills = useMemo(
    () => (diffOn ? buildBaseSkillSet(baseDoc) : new Set<string>()),
    [diffOn, baseDoc],
  );
  const isAdded = (token: string): boolean =>
    diffOn && token.trim().length > 0 && !baseHighlights.has(token.trim());
  const isSkillAdded = (token: string): boolean =>
    diffOn && token.trim().length > 0 && !baseSkills.has(token.trim());
  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "30px 0 60px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "0 44px" }}>
        {compareOn && (
          <div
            className="animate-fade-in"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 13,
              background: diffOn ? "var(--color-coral-bg)" : "#FFFBF4",
              border: `1px solid ${diffOn ? "var(--color-coral-border)" : "#E8DCCA"}`,
              borderRadius: 12,
              padding: "13px 16px",
              marginBottom: 18,
            }}
          >
            <svg
              width={18}
              height={18}
              viewBox="0 0 24 24"
              fill="none"
              stroke={diffOn ? "var(--color-coral)" : "#A66A00"}
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v18" />
              <path d="M5 7l-2 2 2 2M19 7l2 2-2 2" />
              <path d="M3 9h6M15 9h6" />
            </svg>
            <div style={{ flex: 1 }}>
              <div className="ds-body-sm" style={{ fontWeight: 600, color: "#2B2822" }}>
                {diffOn
                  ? `Compare mode — diff vs master ${baseVersionLabel ?? ""}`.trim()
                  : baseDocLoading
                    ? "Compare mode — loading master version…"
                    : "Compare mode"}
              </div>
              <div className="ds-body-sm" style={{ color: "#6B6560", marginTop: 1 }}>
                {diffOn
                  ? "AI-tailored segments are highlighted in coral. Anything unchanged is your master résumé."
                  : baseDocLoading
                    ? "Pulling your master résumé so we can mark what changed."
                    : "Open a tailored variant to see what AI added vs your master."}
              </div>
            </div>
          </div>
        )}

        <div className="ds-card" style={{ padding: "44px 48px", minHeight: 560 }}>
          <div style={{ marginBottom: 24, paddingBottom: 22, borderBottom: "1px solid #EDE8DF" }}>
            <h1 className="ds-h1" style={{ margin: "0 0 4px" }}>{basics.name ?? "Your résumé"}</h1>
            <div className="ds-body-md" style={{ color: "#6B6560" }}>{basics.label ?? ""}</div>
            <div className="ds-mono-11" style={{ color: "#A39F99", marginTop: 7 }}>{contact}</div>
          </div>

          {basics.summary && (
            <Section title="SUMMARY">
              <p className="ds-body-sm" style={{ fontSize: 14, lineHeight: 1.65, color: "#3a352e", margin: 0 }}>
                {diffOn
                  ? tokenise(basics.summary).map((seg, i, arr) => (
                      <DiffSegment
                        key={i}
                        text={seg}
                        added={isAdded(seg)}
                        trailing={i < arr.length - 1 ? " " : ""}
                      />
                    ))
                  : basics.summary}
              </p>
            </Section>
          )}

          {work.length > 0 && (
            <Section
              title="EXPERIENCE"
              trailing={
                showAITouchedLabel ? (
                  <span
                    style={{
                      fontFamily: "JetBrains Mono",
                      fontSize: 9,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                      color: "#A66A00",
                      background: "#F8ECD6",
                      padding: "2px 7px",
                      borderRadius: 4,
                    }}
                  >
                    AI · outcome-led
                  </span>
                ) : null
              }
            >
              {work.map((w, i) => (
                <div key={i} style={{ marginBottom: i === work.length - 1 ? 0 : 20 }}>
                  <div className="ds-body-sm" style={{ fontWeight: 600, fontSize: 14 }}>
                    {w.position} · {w.name}
                  </div>
                  <div className="ds-mono-10" style={{ marginBottom: 12 }}>
                    {[w.startDate, w.endDate].filter(Boolean).join(" – ").toUpperCase()}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {(w.highlights ?? []).map((h, hi) => {
                      const added = isAdded(h);
                      return (
                        <div
                          key={hi}
                          data-ai-generated={added ? "true" : undefined}
                          style={{
                            display: "flex",
                            gap: 11,
                            alignItems: "flex-start",
                            background: added ? "var(--color-coral-bg)" : "transparent",
                            borderLeft: added
                              ? "2px solid var(--color-coral)"
                              : "2px solid transparent",
                            borderRadius: added ? 6 : 0,
                            padding: added ? "5px 9px 5px 9px" : "0",
                            margin: added ? "0 -9px" : 0,
                            transition: "background .14s",
                          }}
                        >
                          <div
                            style={{
                              width: 5,
                              height: 5,
                              borderRadius: 999,
                              background: added ? "var(--color-coral)" : "#5D3000",
                              marginTop: 8,
                              flexShrink: 0,
                            }}
                          />
                          <span
                            className="ds-body-sm"
                            style={{ fontSize: 14, lineHeight: 1.6 }}
                          >
                            {h}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </Section>
          )}

          {skills.length > 0 && (
            <Section title="SKILLS">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {skills.flatMap((s) => s.keywords ?? [s.name ?? ""]).filter(Boolean).map((sk, i) => {
                  const added = isSkillAdded(sk);
                  return (
                    <span
                      key={`${sk}-${i}`}
                      data-ai-generated={added ? "true" : undefined}
                      style={{
                        fontFamily: "Inter",
                        fontWeight: 500,
                        fontSize: 12.5,
                        color: added ? "var(--color-coral)" : "#5D3000",
                        background: added ? "var(--color-coral-bg)" : "#F5EDE3",
                        border: `1px solid ${added ? "var(--color-coral-border)" : "#E8DCCA"}`,
                        padding: "5px 11px",
                        borderRadius: 8,
                      }}
                    >
                      {sk}
                    </span>
                  );
                })}
              </div>
            </Section>
          )}

          {education.length > 0 && (
            <Section title="EDUCATION" last>
              {education.map((e, i) => (
                <div key={i} className="ds-body-sm" style={{ fontSize: 14, marginBottom: i === education.length - 1 ? 0 : 8 }}>
                  {[e.studyType, e.area].filter(Boolean).join(", ")} · {e.institution}
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function ParseProgressBanner({
  status,
  progress,
  fileName,
  error,
  onDismiss,
  onTellDock,
  onRetry,
}: {
  status: "idle" | "running" | "done" | "failed";
  progress: number;
  fileName: string;
  error: string | null;
  onDismiss: () => void;
  onTellDock: () => void;
  onRetry: () => void;
}) {
  // Idle + no error → render nothing. Lets the chrome stay quiet between
  // uploads while preserving the slot for status when a job is live.
  if (status === "idle" && !error) return null;

  const isRunning = status === "running";
  const isDone = status === "done";
  const isFailed = status === "failed" || (status === "idle" && Boolean(error));

  const tone = isFailed
    ? { bg: "var(--color-coral-bg)", border: "var(--color-coral-border)", text: "var(--color-coral)" }
    : isDone
      ? { bg: "var(--color-green-bg)", border: "#C7DDB6", text: "var(--color-green)" }
      : { bg: "var(--color-gold-bg)", border: "var(--color-cream-border)", text: "var(--color-amber)" };

  const label = isFailed
    ? "Parsing failed"
    : isDone
      ? "Parsing complete"
      : "Parsing résumé…";

  // Clamp the progress so a misbehaving backend never pushes the bar off
  // the end of the track.
  const pct = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        flexShrink: 0,
        background: tone.bg,
        borderBottom: `1px solid ${tone.border}`,
        padding: "10px 22px",
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
          }}
        >
          <span
            className="ds-mono-10"
            style={{ color: tone.text, letterSpacing: 0.6 }}
          >
            {label}
          </span>
          {fileName && (
            <span
              className="ds-body-sm"
              style={{
                color: "#3a352e",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              · {fileName}
            </span>
          )}
        </div>
        {isRunning && (
          <div
            style={{
              width: "100%",
              maxWidth: 360,
              height: 5,
              borderRadius: 999,
              background: "rgba(166, 106, 0, 0.18)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: tone.text,
                transition: "width .25s ease",
              }}
            />
          </div>
        )}
        {isFailed && error && (
          <div
            style={{
              fontFamily: "Inter",
              fontSize: 12.5,
              color: "#7a3b32",
              marginTop: 1,
              maxWidth: 560,
            }}
          >
            {error}
          </div>
        )}
        {isDone && (
          <div
            style={{
              fontFamily: "Inter",
              fontSize: 12.5,
              color: "#3a352e",
              marginTop: 1,
            }}
          >
            Saved as a new version. Open the timeline on the left to review.
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {isFailed && (
          <>
            <button
              type="button"
              onClick={onRetry}
              style={chromeBtnStyle(false)}
            >
              Try another file
            </button>
            <button
              type="button"
              onClick={onTellDock}
              style={chromeBtnStyle(false)}
            >
              Ask Vantage
            </button>
          </>
        )}
        {(isDone || isFailed) && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{
              cursor: "pointer",
              border: "none",
              background: "transparent",
              color: tone.text,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
              letterSpacing: 0.5,
              padding: "4px 8px",
            }}
          >
            DISMISS
          </button>
        )}
      </div>
    </div>
  );
}

function DiffSegment({
  text,
  added,
  trailing = "",
}: {
  text: string;
  added: boolean;
  trailing?: string;
}) {
  if (!added) return <>{text}{trailing}</>;
  return (
    <>
      <mark
        data-ai-generated="true"
        style={{
          background: "var(--color-coral-bg)",
          color: "var(--color-coral)",
          borderBottom: "1px solid var(--color-coral-border)",
          padding: "0 2px",
          borderRadius: 3,
        }}
      >
        {text}
      </mark>
      {trailing}
    </>
  );
}

function Section({
  title,
  children,
  trailing,
  last,
}: {
  title: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{ marginBottom: last ? 0 : 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
        <span
          style={{
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 1.3,
            textTransform: "uppercase",
            color: "#6B6560",
          }}
        >
          {title}
        </span>
        {trailing}
      </div>
      {children}
    </div>
  );
}

/**
 * Shown above the document pane when the parse left gaps. Calm amber, not
 * red — the upload itself worked, this is just "AI couldn't structure these
 * bits; want help filling them in?" The action drops the user into Ask Vantage
 * with a pre-filled prompt so they don't have to write it themselves.
 */
function ParseWarningsBanner({
  warnings,
  onAsk,
}: {
  warnings: string[];
  onAsk: () => void;
}) {
  return (
    <div
      style={{
        flexShrink: 0,
        background: "#FFFBF0",
        borderBottom: "1px solid #F2E6CC",
        padding: "12px 22px",
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: 8,
          background: "#FFF3D9",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#A66A00",
          marginTop: 1,
        }}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 13.5, color: "#5D3000", lineHeight: 1.3 }}>
          AI couldn&apos;t fully structure your résumé — your text is saved as v1.
        </div>
        <ul
          style={{
            margin: "6px 0 0 0",
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {warnings.slice(0, 3).map((w, i) => (
            <li
              key={i}
              style={{
                fontFamily: "Inter",
                fontSize: 12.5,
                color: "#5D3000",
                lineHeight: 1.45,
                opacity: 0.85,
              }}
            >
              · {w}
            </li>
          ))}
          {warnings.length > 3 ? (
            <li className="ds-mono-10" style={{ color: "#A66A00", marginTop: 2 }}>
              + {warnings.length - 3} more
            </li>
          ) : null}
        </ul>
      </div>
      <button
        onClick={onAsk}
        style={{
          flexShrink: 0,
          cursor: "pointer",
          border: "1px solid #D6B26E",
          background: "#FFFFFF",
          color: "#5D3000",
          fontFamily: "Inter",
          fontWeight: 600,
          fontSize: 12.5,
          padding: "8px 13px",
          borderRadius: 9,
          whiteSpace: "nowrap",
          transition: "border-color .14s, background .14s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "#5D3000";
          e.currentTarget.style.background = "#F5EDE3";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "#D6B26E";
          e.currentTarget.style.background = "#FFFFFF";
        }}
      >
        Help me fill the gaps →
      </button>
    </div>
  );
}
