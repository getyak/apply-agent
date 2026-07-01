"use client";

// SessionSwitcher — the "+ New session" + switch popover that lives in the
// dock header (and on /app/chat). Multi-session was unlocked by migration
// 019 (lifted the unique-per-user constraint) and the
// /api/ask/sessions CRUD endpoints; this component is the user-facing handle.

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ask, type AskSession } from "@/lib/api";
import {
  useDock,
  type DockSession,
} from "@/lib/ask-vantage-store";
import { useAgentStream } from "@/lib/agent-events";
import { hydrateFromHistory } from "@/lib/agent-events/store";

interface Props {
  /** Visual variant — `compact` for the dock header, `wide` for /app/chat. */
  variant?: "compact" | "wide";
}

function toDockSession(row: AskSession): DockSession {
  return {
    id: row.id,
    threadId: row.threadId,
    label: row.label,
    preview: row.preview,
    messageCount: row.messageCount,
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
  };
}

export function SessionSwitcher({ variant = "compact" }: Props) {
  const t = useTranslations("dock");
  const sessions = useDock((s) => s.sessions);
  const activeSessionId = useDock((s) => s.activeSessionId);
  const setSessions = useDock((s) => s.setSessions);
  const upsertSession = useDock((s) => s.upsertSession);
  const removeSession = useDock((s) => s.removeSession);
  const setActiveSession = useDock((s) => s.setActiveSession);
  const setThreadId = useDock((s) => s.setThreadId);
  const setInput = useDock((s) => s.setInput);
  const streaming = useDock((s) => s.streaming);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await ask.sessions.list();
        if (cancelled) return;
        const rows = res.items.map(toDockSession);
        setSessions(rows);
        if (rows.length > 0 && !activeSessionId) {
          setActiveSession(rows[0].id);
        }
      } catch {
        // Non-fatal: an empty list is the same UX as a failed fetch.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;
  const activeLabel = activeSession?.label ?? t("session.lifetime");

  async function rehydrateThread(threadId: string) {
    try {
      const res = await ask.history(threadId, 50);
      hydrateFromHistory(res.items);
    } catch {
      useAgentStream.getState().reset();
    }
  }

  async function handleSwitch(session: DockSession) {
    if (busy || streaming) return;
    setOpen(false);
    setActiveSession(session.id);
    setThreadId(session.threadId);
    setInput("");
    await rehydrateThread(session.threadId);
  }

  async function handleCreate() {
    if (busy || streaming) return;
    setError(null);
    setBusy(true);
    try {
      const res = await ask.sessions.create();
      const row = toDockSession(res.session);
      upsertSession(row);
      setActiveSession(row.id);
      setThreadId(row.threadId);
      setInput("");
      useAgentStream.getState().reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("session.errorCreate"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(id: string) {
    const label = renameValue.trim();
    if (!label) {
      setRenameId(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await ask.sessions.rename(id, label);
      upsertSession(toDockSession(res.session));
      setRenameId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("session.errorRename"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    setError(null);
    try {
      await ask.sessions.remove(id);
      removeSession(id);
      setPendingDelete(null);
      const remaining = useDock.getState().sessions;
      if (useDock.getState().activeSessionId === null) {
        if (remaining.length > 0) {
          const next = remaining[0];
          setActiveSession(next.id);
          setThreadId(next.threadId);
          await rehydrateThread(next.threadId);
        } else {
          useAgentStream.getState().reset();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("session.errorDelete"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-tour="session-switcher"
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("session.switchTitle")}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: open ? "#F5EDE3" : "transparent",
          border: "1px solid transparent",
          borderRadius: 8,
          padding: variant === "wide" ? "5px 9px" : "3px 6px",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          fontSize: variant === "wide" ? 11 : 10,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "#5D3000",
          maxWidth: variant === "wide" ? 320 : 200,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          transition: "background .14s, border-color .14s",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "#F5EFE5";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "transparent";
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: variant === "wide" ? 280 : 160,
          }}
        >
          {activeLabel}
        </span>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        type="button"
        onClick={handleCreate}
        disabled={busy || streaming}
        title={t("session.newTitle")}
        aria-label={t("session.newTitle")}
        style={{
          cursor: busy || streaming ? "not-allowed" : "pointer",
          background: "transparent",
          border: "1px solid #EDE8DF",
          borderRadius: 999,
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#5D3000",
          opacity: busy || streaming ? 0.55 : 1,
          transition: "background .14s, border-color .14s, transform .14s",
        }}
        onMouseEnter={(e) => {
          if (busy || streaming) return;
          e.currentTarget.style.background = "#5D3000";
          e.currentTarget.style.color = "#FAF8F6";
          e.currentTarget.style.transform = "translateY(-1px)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "#5D3000";
          e.currentTarget.style.transform = "translateY(0)";
        }}
      >
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label={t("session.popoverLabel")}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 70,
            width: variant === "wide" ? 360 : 304,
            maxHeight: 380,
            overflowY: "auto",
            background: "#FFFFFF",
            border: "1px solid #EDE8DF",
            borderRadius: 12,
            boxShadow: "0 14px 32px rgba(40,25,5,.14)",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            className="ds-mono-9"
            style={{ padding: "6px 10px", color: "#A39F99" }}
          >
            {t("session.popoverHint")}
          </div>
          {sessions.length === 0 ? (
            <div
              className="ds-body-sm"
              style={{ padding: "10px 12px", color: "#6B6560" }}
            >
              {t("session.emptyHint")}
            </div>
          ) : (
            sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const isRenaming = renameId === session.id;
              const pending = pendingDelete === session.id;
              return (
                <div
                  key={session.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 8px",
                    borderRadius: 8,
                    background: isActive ? "#FBF8F3" : "transparent",
                    transition: "background .12s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = "#FBF8F3";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleRename(session.id);
                        } else if (e.key === "Escape") {
                          setRenameId(null);
                        }
                      }}
                      onBlur={() => void handleRename(session.id)}
                      placeholder={t("session.renamePlaceholder")}
                      maxLength={80}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: "1px solid #5D3000",
                        borderRadius: 6,
                        padding: "4px 8px",
                        fontFamily: "Inter, system-ui, sans-serif",
                        fontSize: 13,
                        outline: "none",
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => void handleSwitch(session)}
                      disabled={busy || streaming}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        cursor: busy || streaming ? "not-allowed" : "pointer",
                        padding: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: 1,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "Inter, system-ui, sans-serif",
                          fontWeight: isActive ? 600 : 500,
                          fontSize: 13.5,
                          color: "#2B2822",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {session.label}
                      </span>
                      <span
                        className="ds-mono-9"
                        style={{
                          color: "#A39F99",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {session.preview ?? t("session.noPreview")}
                      </span>
                    </button>
                  )}
                  {pending ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleDelete(session.id)}
                        disabled={busy}
                        title={t("session.confirmDelete")}
                        style={iconBtn("#A23A2E")}
                      >
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12l5 5L20 7" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(null)}
                        disabled={busy}
                        title={t("session.cancel")}
                        style={iconBtn("#6B6560")}
                      >
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </>
                  ) : !isRenaming ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setRenameId(session.id);
                          setRenameValue(session.label);
                        }}
                        disabled={busy || streaming}
                        title={t("session.rename")}
                        aria-label={t("session.rename")}
                        style={iconBtn("#6B6560")}
                      >
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 20h9M16.5 3.5l4 4L7 21H3v-4z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(session.id)}
                        disabled={busy || streaming}
                        title={t("session.delete")}
                        aria-label={t("session.delete")}
                        style={iconBtn("#6B6560")}
                      >
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
                        </svg>
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })
          )}
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy || streaming}
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px dashed #E8DCCA",
              background: busy || streaming ? "#FBF8F3" : "#FFFBF4",
              color: "#5D3000",
              cursor: busy || streaming ? "not-allowed" : "pointer",
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 500,
              fontSize: 13.5,
              opacity: busy || streaming ? 0.55 : 1,
            }}
          >
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t("session.newButton")}
          </button>
          {error && (
            <div
              role="alert"
              style={{
                marginTop: 4,
                padding: "6px 10px",
                color: "#A23A2E",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function iconBtn(color: string): React.CSSProperties {
  return {
    cursor: "pointer",
    background: "transparent",
    border: "none",
    width: 22,
    height: 22,
    borderRadius: 6,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color,
    transition: "background .12s, color .12s",
  };
}
