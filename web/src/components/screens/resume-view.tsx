"use client";

// Résumé view — document + version timeline, NO chat input.
// Per docs/architecture/vantage-ui-mapping.md §2:
//   "All résumé edits route through Ask Vantage; this view is the
//    document face plus a version rail."
// Vantage.dc.html lines 392–583 are the visual contract.
//
// We mount it under /app/studio/resume. The Builder overlay (the old
// chat-driven "build from scratch" flow) remains separately reachable.

import { useEffect, useMemo, useState } from "react";
import { resumes as resumesApi } from "@/lib/api";
import { useDock } from "@/lib/ask-vantage-store";
import { useVantage } from "@/lib/store";

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

  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<JsonResume | null>(null);
  const [loading, setLoading] = useState(true);
  const [compareOn, setCompareOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
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

  function askToTailor() {
    const dock = useDock.getState();
    dock.open();
    dock.setInput("Tailor this résumé for a new role — ");
  }

  function askToUpload() {
    const dock = useDock.getState();
    dock.open();
    dock.setInput("I want to upload a new résumé.");
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

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#FAF8F6" }}>
        <span className="ds-mono-10">LOADING RÉSUMÉ…</span>
      </div>
    );
  }

  if (error && versions.length === 0) {
    return (
      <div style={{ padding: 32, background: "#FAF8F6", height: "100%" }}>
        <div className="ds-card" style={{ padding: 22, maxWidth: 540 }}>
          <div className="ds-headline-caps" style={{ color: "#A23A2E", marginBottom: 8 }}>
            COULDN&apos;T LOAD RÉSUMÉ
          </div>
          <p className="ds-body-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (versions.length === 0 || !doc) {
    return (
      <div style={{ padding: 32, background: "#FAF8F6", height: "100%" }}>
        <div className="ds-card" style={{ padding: 28, maxWidth: 540 }}>
          <div className="ds-headline-caps" style={{ marginBottom: 8 }}>NO RÉSUMÉ YET</div>
          <p className="ds-body-sm" style={{ marginBottom: 18 }}>
            Upload one, or build one by talking to Vantage.
          </p>
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
            Get started with Vantage
          </button>
        </div>
      </div>
    );
  }

  const basics = doc.basics ?? {};
  const contact = [basics.email, basics.phone, [basics.location?.city, basics.location?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#FAF8F6" }}>
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
        />
      </div>
    </div>
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

function DocumentPane({
  basics,
  contact,
  work,
  skills,
  education,
  showAITouchedLabel,
  compareOn,
}: {
  basics: JsonResumeBasics;
  contact: string;
  work: JsonResumeWork[];
  skills: JsonResumeSkill[];
  education: JsonResumeEducation[];
  showAITouchedLabel: boolean;
  compareOn: boolean;
}) {
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
              background: "#FFFBF4",
              border: "1px solid #E8DCCA",
              borderRadius: 12,
              padding: "13px 16px",
              marginBottom: 18,
            }}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#A66A00" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v18" />
              <path d="M5 7l-2 2 2 2M19 7l2 2-2 2" />
              <path d="M3 9h6M15 9h6" />
            </svg>
            <div style={{ flex: 1 }}>
              <div className="ds-body-sm" style={{ fontWeight: 600, color: "#2B2822" }}>
                Compare mode
              </div>
              <div className="ds-body-sm" style={{ color: "#6B6560", marginTop: 1 }}>
                Diff between versions arrives with the next backend pass — Vantage will mark added text in green, removed in red.
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
                {basics.summary}
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
                    {(w.highlights ?? []).map((h, hi) => (
                      <div key={hi} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                        <div style={{ width: 5, height: 5, borderRadius: 999, background: "#5D3000", marginTop: 8, flexShrink: 0 }} />
                        <span className="ds-body-sm" style={{ fontSize: 14, lineHeight: 1.6 }}>{h}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Section>
          )}

          {skills.length > 0 && (
            <Section title="SKILLS">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {skills.flatMap((s) => s.keywords ?? [s.name ?? ""]).filter(Boolean).map((sk, i) => (
                  <span
                    key={`${sk}-${i}`}
                    style={{
                      fontFamily: "Inter",
                      fontWeight: 500,
                      fontSize: 12.5,
                      color: "#5D3000",
                      background: "#F5EDE3",
                      border: "1px solid #E8DCCA",
                      padding: "5px 11px",
                      borderRadius: 8,
                    }}
                  >
                    {sk}
                  </span>
                ))}
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
