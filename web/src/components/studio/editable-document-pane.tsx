// Editable document pane — the Optimized tab's inline-editor surface.
//
// Renders the JsonResume document with every text field plumbed through the
// useResumeEdit hook. Layout intentionally tracks the read-only DocumentPane
// in resume-view.tsx so the visual contract (Vantage.dc.html lines 392–583)
// is preserved — only the leaf cells are swapped for InlineText /
// InlineParagraph / InlineBullet.
//
// Two top-level surfaces drawn here:
//   1. The "status zone" chip strip — Save snapshot, Discard draft, plus
//      the four-state status pill (idle / draft / saving / saved / offline /
//      error). Cmd+S = saveSnapshot.
//   2. The 409 conflict banner (§5) with three reconciles. We fetch
//      "their" version on demand the first time the user opens it so the
//      banner can show vN+1 next to the buttons.
//
// We deliberately don't render bullets that don't exist yet: an "Add bullet"
// button appears at the bottom of every role's list. Adding writes
// commit("work.<i>.highlights.<n>", "") which both creates a new bullet AND
// schedules an autosave — the user just types into the new spot.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { resumes as resumesApi } from "@/lib/api";
import type { ResumeDoc, SaveStatus } from "@/lib/use-resume-edit";
import { useResumeEdit } from "@/lib/use-resume-edit";
import { InlineBullet, InlineParagraph, InlineText } from "./inline-edit";

interface EditableProps {
  /** The résumé being edited. `null` triggers the inert "no résumé" path —
   *  parent already shows an empty state in that case. */
  resumeId: string | null;
  baseVersion: number;
  initialDoc: ResumeDoc | null;
  /** Pending AI suggestions targeting this résumé. Used by R-6 to attach
   *  a small "Suggestion pending in dock" hint above the matching bullet.
   *  Keyed on the bullet path ("work.0.highlights.2"). */
  pendingSuggestionsByBullet?: Map<string, { afterText: string; suggestionId: string }>;
  /** The parent owns the version list / source-of-truth doc. We notify it
   *  whenever a save lands so it can refresh the rail and bump the GET. */
  onSaved?: (next: ResumeDoc, version: number, mode: "draft" | "snapshot") => void;
}

type JsonWork = {
  name?: string;
  position?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  highlights?: string[];
};

type JsonBasics = {
  name?: string;
  label?: string;
  email?: string;
  phone?: string;
  location?: { city?: string; region?: string };
  summary?: string;
};

const dateValidate = (value: string): string | null => {
  if (!value) return null;
  if (/^\d{4}(-\d{2})?$/.test(value)) return null;
  return "Use YYYY-MM (e.g. 2023-08)";
};

const emailValidate = (value: string): string | null => {
  if (!value) return null;
  // Forgiving check — anything with "@" and a dot after it. Strict RFC-5322
  // bites users with valid-but-rare addresses (+ tags, IDN, …).
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) return null;
  return "Enter a valid email";
};

export function EditableDocumentPane({
  resumeId,
  baseVersion,
  initialDoc,
  pendingSuggestionsByBullet,
  onSaved,
}: EditableProps) {
  const t = useTranslations("resume");
  const {
    draft,
    dirty,
    status,
    conflict,
    version,
    commit,
    saveSnapshot,
    discardDraft,
    adoptTheirs,
    branchFromTheirs,
  } = useResumeEdit({
    resumeId,
    baseVersion,
    initialDoc,
    onSaved,
  });

  // Cmd+S / Ctrl+S → saveSnapshot. Capture phase so we beat the browser's
  // "save page" dialog. Only active when there's a résumé to save against
  // and we're not staring at a conflict (the banner handles input first).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (!resumeId || conflict) return;
        e.preventDefault();
        void saveSnapshot();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [resumeId, conflict, saveSnapshot]);

  // Resolved when the user opens the conflict banner — we fetch "their"
  // version once and stash it so all three reconcile buttons have the data.
  const [theirCopy, setTheirCopy] = useState<{
    doc: ResumeDoc;
    version: number;
  } | null>(null);
  const conflictFetchRef = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (!conflict || !resumeId) {
      setTheirCopy(null);
      conflictFetchRef.current = null;
      return;
    }
    if (conflictFetchRef.current) return;
    conflictFetchRef.current = (async () => {
      try {
        const res = await resumesApi.get(resumeId);
        setTheirCopy({
          doc: (res.resume.content ?? {}) as ResumeDoc,
          version: res.resume.version,
        });
      } catch {
        // If the fetch fails (network drop) we let the user try again by
        // clicking a reconcile button — those re-trigger by themselves.
        conflictFetchRef.current = null;
      }
    })();
  }, [conflict, resumeId]);

  const pendingMap = pendingSuggestionsByBullet ?? new Map();

  const basics = ((draft?.basics ?? {}) as JsonBasics) || {};
  const work = useMemo<JsonWork[]>(
    () => (Array.isArray(draft?.work) ? (draft!.work as JsonWork[]) : []),
    [draft],
  );

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <SaveStatusBar
        status={status}
        version={version}
        dirtyCount={dirty.size}
        onSaveSnapshot={() => void saveSnapshot()}
        onDiscard={discardDraft}
        t={t}
      />
      {conflict ? (
        <ConflictBanner
          attemptedVersion={conflict.attemptedVersion}
          theirVersion={theirCopy?.version}
          onViewTheirs={() => {
            if (theirCopy) adoptTheirs(theirCopy.doc, theirCopy.version);
          }}
          onBranch={() => {
            if (theirCopy) branchFromTheirs(theirCopy.doc, theirCopy.version);
          }}
          onDiscard={discardDraft}
          t={t}
        />
      ) : null}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "32px 40px 80px",
          background: "#FAF8F6",
        }}
      >
        <div
          style={{
            maxWidth: 760,
            margin: "0 auto",
            background: "#FFFFFF",
            border: "1px solid #EDE8DF",
            borderRadius: 14,
            padding: "44px 48px",
            boxShadow: "0 1px 0 rgba(0,0,0,0.02)",
            fontFamily:
              "Newsreader, ui-serif, Georgia, Cambria, 'Times New Roman', serif",
            color: "rgba(48, 38, 32, 0.92)",
            lineHeight: 1.55,
          }}
        >
          {/* ── Basics ───────────────────────────────────────────────── */}
          <div style={{ marginBottom: 24 }}>
            <h1
              style={{
                fontFamily: "Inter",
                fontWeight: 700,
                fontSize: 28,
                margin: "0 0 6px",
                letterSpacing: -0.4,
                color: "#1F1B17",
              }}
            >
              <InlineText
                data-testid="basics-name"
                value={basics.name}
                onCommit={(v) => commit("basics.name", v)}
                placeholder={t("editor.placeholder.name")}
              />
            </h1>
            <div
              style={{
                fontFamily: "Inter",
                fontWeight: 500,
                fontSize: 14,
                color: "rgba(48,38,32,0.7)",
                marginBottom: 10,
              }}
            >
              <InlineText
                data-testid="basics-label"
                value={basics.label}
                onCommit={(v) => commit("basics.label", v)}
                placeholder={t("editor.placeholder.label")}
                tone="secondary"
              />
            </div>
            <div
              style={{
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
                fontFamily: "JetBrains Mono",
                fontSize: 12,
                color: "rgba(48,38,32,0.62)",
              }}
            >
              <InlineText
                data-testid="basics-email"
                value={basics.email}
                onCommit={(v) => commit("basics.email", v)}
                placeholder={t("editor.placeholder.email")}
                validate={emailValidate}
                tone="secondary"
              />
              <InlineText
                data-testid="basics-phone"
                value={basics.phone}
                onCommit={(v) => commit("basics.phone", v)}
                placeholder={t("editor.placeholder.phone")}
                tone="secondary"
              />
              <InlineText
                data-testid="basics-location"
                value={[basics.location?.city, basics.location?.region]
                  .filter(Boolean)
                  .join(", ")}
                onCommit={(v) => {
                  const [city = "", region = ""] = v.split(",").map((s) => s.trim());
                  commit("basics.location", { city, region });
                }}
                placeholder={t("editor.placeholder.location")}
                tone="secondary"
              />
            </div>
          </div>

          {/* ── Summary ──────────────────────────────────────────────── */}
          <Section title={t("editor.section.summary")}>
            <InlineParagraph
              data-testid="basics-summary"
              value={basics.summary}
              onCommit={(v) => commit("basics.summary", v)}
              placeholder={t("editor.placeholder.summary")}
            />
          </Section>

          {/* ── Experience ───────────────────────────────────────────── */}
          <Section
            title={t("editor.section.experience")}
            accessory={
              <button
                onClick={() => {
                  const next = work.length;
                  commit(`work.${next}`, {
                    name: "",
                    position: "",
                    startDate: "",
                    endDate: "",
                    summary: "",
                    highlights: [""],
                  });
                }}
                style={addRoleBtnStyle}
              >
                + {t("editor.action.addRole")}
              </button>
            }
          >
            {work.map((role, i) => (
              <div key={i} style={{ marginBottom: 26 }}>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 10,
                    alignItems: "baseline",
                    marginBottom: 6,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "Inter",
                      fontWeight: 600,
                      fontSize: 16,
                      color: "#1F1B17",
                    }}
                  >
                    <InlineText
                      data-testid={`work-${i}-name`}
                      value={role.name}
                      onCommit={(v) => commit(`work.${i}.name`, v)}
                      placeholder={t("editor.placeholder.company")}
                    />
                  </div>
                  <div style={{ color: "rgba(48,38,32,0.45)" }}>·</div>
                  <div
                    style={{
                      fontFamily: "Inter",
                      fontWeight: 500,
                      fontSize: 14,
                      color: "rgba(48,38,32,0.78)",
                    }}
                  >
                    <InlineText
                      data-testid={`work-${i}-position`}
                      value={role.position}
                      onCommit={(v) => commit(`work.${i}.position`, v)}
                      placeholder={t("editor.placeholder.role")}
                    />
                  </div>
                  <div
                    style={{
                      marginLeft: "auto",
                      fontFamily: "JetBrains Mono",
                      fontSize: 11,
                      color: "rgba(48,38,32,0.55)",
                      display: "flex",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    <InlineText
                      data-testid={`work-${i}-start`}
                      value={role.startDate}
                      onCommit={(v) => commit(`work.${i}.startDate`, v)}
                      placeholder="YYYY-MM"
                      validate={dateValidate}
                      tone="secondary"
                    />
                    <span>–</span>
                    <InlineText
                      data-testid={`work-${i}-end`}
                      value={role.endDate}
                      onCommit={(v) => commit(`work.${i}.endDate`, v)}
                      placeholder={t("editor.placeholder.dateEnd")}
                      validate={dateValidate}
                      tone="secondary"
                    />
                  </div>
                </div>
                {role.summary !== undefined ? (
                  <div style={{ marginBottom: 8 }}>
                    <InlineParagraph
                      data-testid={`work-${i}-summary`}
                      value={role.summary}
                      onCommit={(v) => commit(`work.${i}.summary`, v)}
                      placeholder={t("editor.placeholder.roleSummary")}
                      tone="secondary"
                    />
                  </div>
                ) : null}
                <ul style={{ margin: "8px 0 0 0", padding: 0 }}>
                  {(role.highlights ?? []).map((h, j) => {
                    const path = `work.${i}.highlights.${j}`;
                    const pending = pendingMap.get(path);
                    return (
                      <InlineBullet
                        key={j}
                        data-testid={`bullet-${i}-${j}`}
                        value={h}
                        onCommit={(v) => commit(path, v)}
                        onDeleteEmpty={() => {
                          const next = (role.highlights ?? []).filter(
                            (_, idx) => idx !== j,
                          );
                          commit(`work.${i}.highlights`, next);
                        }}
                        placeholder={t("editor.placeholder.bullet")}
                        pendingSuggestionHint={
                          pending ? t("editor.pendingSuggestion") : undefined
                        }
                      />
                    );
                  })}
                  <li style={{ listStyle: "none", paddingLeft: 26 }}>
                    <button
                      onClick={() => {
                        const next = (role.highlights ?? []).length;
                        commit(`work.${i}.highlights.${next}`, "");
                      }}
                      style={addBulletBtnStyle}
                    >
                      + {t("editor.action.addBullet")}
                    </button>
                  </li>
                </ul>
              </div>
            ))}
            {work.length === 0 ? (
              <div style={{ color: "rgba(48,38,32,0.55)", fontStyle: "italic" }}>
                {t("editor.empty.experience")}
              </div>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  accessory,
  children,
}: {
  title: string;
  accessory?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 18, marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
          borderBottom: "1px solid #EDE8DF",
          paddingBottom: 6,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontFamily: "JetBrains Mono",
            fontSize: 11,
            letterSpacing: 1.3,
            textTransform: "uppercase",
            color: "rgba(48,38,32,0.55)",
          }}
        >
          {title}
        </h2>
        {accessory}
      </div>
      {children}
    </section>
  );
}

const addRoleBtnStyle: React.CSSProperties = {
  border: "1px dashed #D6CEC0",
  background: "transparent",
  color: "rgba(48,38,32,0.7)",
  fontFamily: "Inter",
  fontWeight: 500,
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 8,
  cursor: "pointer",
};

const addBulletBtnStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "rgba(212, 162, 65, 0.95)",
  fontFamily: "Inter",
  fontWeight: 500,
  fontSize: 12,
  padding: "2px 6px",
  marginTop: 2,
  cursor: "pointer",
};

type StatusBarT = (key: string, values?: Record<string, string | number>) => string;

function SaveStatusBar({
  status,
  version,
  dirtyCount,
  onSaveSnapshot,
  onDiscard,
  t,
}: {
  status: SaveStatus;
  version: number;
  dirtyCount: number;
  onSaveSnapshot: () => void;
  onDiscard: () => void;
  t: StatusBarT;
}) {
  const pill = renderStatusPill(status, version, t);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 22px",
        borderBottom: "1px solid #EDE8DF",
        background: "#FFFFFF",
        flexShrink: 0,
      }}
    >
      {pill}
      <span
        style={{
          fontFamily: "JetBrains Mono",
          fontSize: 11,
          color: "rgba(48,38,32,0.45)",
        }}
      >
        v{version}
        {dirtyCount > 0 ? ` · ${t("editor.dirtyCount", { n: dirtyCount })}` : ""}
      </span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <button
          onClick={onDiscard}
          disabled={dirtyCount === 0}
          style={{
            ...secondaryBtn,
            opacity: dirtyCount === 0 ? 0.45 : 1,
            cursor: dirtyCount === 0 ? "default" : "pointer",
          }}
        >
          {t("editor.action.discard")}
        </button>
        <button
          onClick={onSaveSnapshot}
          data-testid="save-snapshot"
          style={primaryBtn}
        >
          {t("editor.action.saveSnapshot")}
          <span
            style={{
              marginLeft: 6,
              fontFamily: "JetBrains Mono",
              fontSize: 10,
              opacity: 0.75,
            }}
          >
            ⌘S
          </span>
        </button>
      </div>
    </div>
  );
}

function renderStatusPill(status: SaveStatus, _version: number, t: StatusBarT) {
  const palette: Record<
    string,
    { bg: string; fg: string; dot: string; label: string }
  > = {
    idle: {
      bg: "rgba(76,122,63,0.08)",
      fg: "#4C7A3F",
      dot: "#4C7A3F",
      label: t("editor.status.saved"),
    },
    draft: {
      bg: "rgba(212,162,65,0.10)",
      fg: "#9E7B30",
      dot: "#D4A241",
      label: t("editor.status.draft"),
    },
    saving: {
      bg: "rgba(212,162,65,0.10)",
      fg: "#9E7B30",
      dot: "#D4A241",
      label: t("editor.status.saving"),
    },
    saved: {
      bg: "rgba(76,122,63,0.10)",
      fg: "#4C7A3F",
      dot: "#4C7A3F",
      label: t("editor.status.savedJust"),
    },
    offline: {
      bg: "rgba(162,58,46,0.10)",
      fg: "#A23A2E",
      dot: "#A23A2E",
      label: t("editor.status.offline"),
    },
    error: {
      bg: "rgba(162,58,46,0.10)",
      fg: "#A23A2E",
      dot: "#A23A2E",
      label: t("editor.status.error"),
    },
  };
  const p = palette[status.kind] ?? palette.idle!;
  return (
    <span
      data-testid="save-status"
      data-status={status.kind}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 10px",
        borderRadius: 999,
        background: p.bg,
        color: p.fg,
        fontFamily: "JetBrains Mono",
        fontSize: 10,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: p.dot,
        }}
      />
      {status.kind === "saved" && status.mode === "snapshot"
        ? t("editor.status.savedAs", { v: status.version })
        : p.label}
    </span>
  );
}

function ConflictBanner({
  attemptedVersion,
  theirVersion,
  onViewTheirs,
  onBranch,
  onDiscard,
  t,
}: {
  attemptedVersion: number;
  theirVersion?: number;
  onViewTheirs: () => void;
  onBranch: () => void;
  onDiscard: () => void;
  t: StatusBarT;
}) {
  return (
    <div
      data-testid="conflict-banner"
      style={{
        padding: "12px 22px",
        background: "rgba(162,58,46,0.06)",
        borderBottom: "1px solid rgba(162,58,46,0.25)",
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontFamily: "Inter",
          fontWeight: 600,
          fontSize: 13,
          color: "#A23A2E",
        }}
      >
        ⚠ {t("editor.conflict.title")}
      </div>
      <div
        style={{
          fontFamily: "Inter",
          fontSize: 12,
          color: "rgba(48,38,32,0.72)",
          maxWidth: 540,
        }}
      >
        {theirVersion != null
          ? t("editor.conflict.body", {
              theirs: theirVersion,
              attempted: attemptedVersion,
            })
          : t("editor.conflict.bodyLoading")}
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <button onClick={onViewTheirs} style={secondaryBtn} disabled={!theirVersion}>
          {t("editor.conflict.viewTheirs")}
        </button>
        <button onClick={onBranch} style={primaryBtn} disabled={!theirVersion}>
          {t("editor.conflict.branch")}
        </button>
        <button onClick={onDiscard} style={destructiveBtn}>
          {t("editor.conflict.discard")}
        </button>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  border: "none",
  background: "#5D3000",
  color: "#FAF8F6",
  padding: "7px 14px",
  borderRadius: 8,
  fontFamily: "Inter",
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  border: "1px solid #D6CEC0",
  background: "#FFFFFF",
  color: "#2B2822",
  padding: "7px 14px",
  borderRadius: 8,
  fontFamily: "Inter",
  fontWeight: 500,
  fontSize: 12,
  cursor: "pointer",
};

const destructiveBtn: React.CSSProperties = {
  border: "1px solid rgba(162,58,46,0.45)",
  background: "transparent",
  color: "#A23A2E",
  padding: "7px 14px",
  borderRadius: 8,
  fontFamily: "Inter",
  fontWeight: 500,
  fontSize: 12,
  cursor: "pointer",
};
