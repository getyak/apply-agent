"use client";

// ChatView — /app/chat page. Now mirrors the Ask Vantage dock visual + UX
// language (vantage-ui-mapping.md "one conversation" doctrine extended to
// the chat page): the page reuses the dock's session switcher, agent
// timeline, slash palette, and composer so the two surfaces feel like the
// same product.

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDock, type DockAttachment } from "@/lib/ask-vantage-store";
import {
  sendAsk,
  useAgentStream,
  useHasSteps,
  useIsStreaming,
} from "@/lib/agent-events";
import { files as filesApi, ask } from "@/lib/api";
import { useVantage } from "@/lib/store";
import { greetingFor } from "@/lib/dates";
import { StepTimeline } from "@/components/ask-vantage/step-timeline";
import { SessionSwitcher } from "@/components/ask-vantage/session-switcher";
import { SlashPalette, type SlashCommandId } from "@/components/ask-vantage/slash-palette";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ATTACH_ACCEPT =
  ".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.gif," +
  "application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "text/plain,image/png,image/jpeg,image/webp,image/gif";

export function ChatView() {
  const t = useTranslations("dock");
  const tChat = useTranslations("chat");

  const input = useDock((s) => s.input);
  const setInput = useDock((s) => s.setInput);
  const attachments = useDock((s) => s.attachments);
  const streaming = useIsStreaming();
  const hasSteps = useHasSteps();
  const stepCount = useAgentStream((s) => s.order.length);
  const cancelStream = useDock((s) => s.cancelStream);

  const pathname = usePathname();
  const router = useRouter();
  const currentUser = useVantage((s) => s.currentUser);
  const parsedResume = useVantage((s) => s.parsedResume);
  const loadCurrentUser = useVantage((s) => s.loadCurrentUser);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!currentUser) loadCurrentUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [stepCount, streaming]);

  useEffect(() => {
    return () => {
      const dock = useDock.getState();
      if (dock.streaming || dock.abortController) cancelStream();
    };
  }, [cancelStream]);

  const firstName = useMemo(() => {
    const resumeName = parsedResume?.basics?.name?.trim() ?? "";
    const auth = currentUser?.displayName?.trim() ?? "";
    const source = resumeName || auth;
    return source.split(/\s+/)[0] ?? "";
  }, [parsedResume, currentUser]);

  const headerDate = useMemo(() => {
    const d = new Date();
    return d
      .toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" })
      .toUpperCase();
  }, []);
  const greeting = useMemo(() => {
    const g = greetingFor();
    const key = g === "Good morning" ? "morning" : g === "Good afternoon" ? "afternoon" : "evening";
    return t(`greeting.timeOfDay.${key}`);
  }, [t]);

  // --- Slash palette state ---
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const slashRangeRef = useRef<{ start: number; end: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [input]);

  function submit() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    if (text && text.length < 2 && attachments.length === 0) return;
    const finalPrompt = text || t("reviewAttachments");
    void sendAsk(finalPrompt, attachments);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !slashOpen) {
      e.preventDefault();
      submit();
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setInput(v);
    const caret = e.target.selectionStart ?? v.length;
    const upto = v.slice(0, caret);
    const slashMatch = /(^|\s)(\/[A-Za-z0-9_\-:/]*)$/.exec(upto);
    if (slashMatch) {
      const triggerStart = caret - slashMatch[2].length;
      slashRangeRef.current = { start: triggerStart, end: caret };
      setSlashOpen(true);
      setSlashQuery(slashMatch[2].slice(1));
    } else {
      setSlashOpen(false);
      slashRangeRef.current = null;
    }
  }

  function handleSlashPick(insertion: string) {
    const el = textareaRef.current;
    const range = slashRangeRef.current;
    if (!el || !range) return;
    const next = `${input.slice(0, range.start)}${insertion}${input.slice(range.end)}`;
    setInput(next);
    setSlashOpen(false);
    slashRangeRef.current = null;
    setTimeout(() => {
      el.focus();
      const pos = range.start + insertion.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  async function handleSlashCommand(id: SlashCommandId, args: string) {
    const range = slashRangeRef.current;
    const cleared = range
      ? `${input.slice(0, range.start)}${input.slice(range.end)}`
      : input;
    setSlashOpen(false);
    slashRangeRef.current = null;

    switch (id) {
      case "new": {
        try {
          const res = await ask.sessions.create();
          useDock.getState().upsertSession({
            id: res.session.id,
            threadId: res.session.threadId,
            label: res.session.label,
            preview: res.session.preview,
            messageCount: res.session.messageCount,
            lastActiveAt: res.session.lastActiveAt,
            createdAt: res.session.createdAt,
          });
          useDock.getState().setActiveSession(res.session.id);
          useDock.getState().setThreadId(res.session.threadId);
          setInput("");
          useAgentStream.getState().reset();
        } catch {
          /* keep silent */
        }
        return;
      }
      case "clear": {
        useAgentStream.getState().reset();
        setInput(cleared);
        return;
      }
      case "search": {
        const query = args.trim();
        if (!query) {
          setInput("/search ");
          setTimeout(() => textareaRef.current?.focus(), 0);
          return;
        }
        const prompt =
          `[deep-research] Investigate the following thoroughly. Search the web, read the top sources, ` +
          `cross-check claims, then return a synthesised brief with linked references:\n\n${query}`;
        setInput("");
        void sendAsk(prompt, []);
        return;
      }
      case "help": {
        const prompt =
          "How does the Ask Vantage dock work? Explain sessions, the / command palette, " +
          "@ mentions, file attachments, and how the lifetime thread differs from a fresh session.";
        setInput("");
        void sendAsk(prompt, []);
        return;
      }
      case "focus": {
        // Already fullscreen — no-op the dock toggle, just clear the slug.
        setInput(cleared);
        return;
      }
    }
  }

  // Esc on /app/chat → leave the chat surface and go back to the workspace
  // (Today). Same posture as the dock's Esc-collapses-fullscreen behaviour.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (slashOpen) return; // Slash palette owns Esc when it's open.
      router.push("/app/today");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, slashOpen]);

  // --- Composer-only state (attach + voice) reused from the dock spec ---
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* recognition may already be stopped */
      }
    };
  }, []);

  const speechSupported = useMemo(() => getSpeechRecognitionCtor() !== null, []);

  async function handleFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const res = await filesApi.upload(file);
      if (!res.file) {
        setUploadError(t("composer.uploadNoId"));
        return;
      }
      const att: DockAttachment = {
        id: res.file.id,
        name: res.file.filename,
        sizeBytes: res.file.sizeBytes,
        kind: res.kind,
      };
      useDock.getState().addAttachment(att);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("composer.uploadFailed");
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  }

  function startListening() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let transcript = "";
      const results = e.results;
      for (let i = 0; i < results.length; i++) {
        const alt = results[i][0];
        if (alt && typeof alt.transcript === "string") transcript += alt.transcript;
      }
      setInput(transcript.trimStart());
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  function stopListening() {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* noop */
    }
    setListening(false);
  }

  const hasContent = input.trim().length > 0 || attachments.length > 0;
  const sendDisabled = streaming || !hasContent;

  // Suppress the global dock when in the dedicated chat page so we don't
  // render two parallel composers.
  useEffect(() => {
    if (!pathname?.startsWith("/app/chat")) return;
    const prev = useDock.getState().state;
    useDock.setState({ state: "closed" });
    return () => {
      if (prev === "docked" || prev === "full") {
        useDock.setState({ state: prev });
      }
    };
  }, [pathname]);

  const who = firstName?.trim() || t("greeting.fallbackName");

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#FBF8F3",
      }}
    >
      <div
        className="ds-backdrop"
        style={{
          flexShrink: 0,
          borderBottom: "1px solid #EDE8DF",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "16px 32px",
          minHeight: 70,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: "#5D3000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg
            width={17}
            height={17}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#FAF8F6"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9.5 2.5l1.7 4.6 4.9.2-3.8 3 1.3 4.7-4-2.8-4 2.8 1.3-4.7-3.8-3 4.9-.2z" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 15,
              color: "#2B2822",
              lineHeight: 1.1,
            }}
          >
            {t("askVantage")}
          </div>
          <div style={{ marginTop: 4 }}>
            <SessionSwitcher variant="wide" />
          </div>
        </div>
        {/* Standalone "+ New session" — same affordance the dock header carries.
            Lives on the chat page so the user doesn't need to discover the
            SessionSwitcher popover to start a fresh thread. */}
        <button
          type="button"
          onClick={async () => {
            try {
              const res = await ask.sessions.create();
              useDock.getState().upsertSession({
                id: res.session.id,
                threadId: res.session.threadId,
                label: res.session.label,
                preview: res.session.preview,
                messageCount: res.session.messageCount,
                lastActiveAt: res.session.lastActiveAt,
                createdAt: res.session.createdAt,
              });
              useDock.getState().setActiveSession(res.session.id);
              useDock.getState().setThreadId(res.session.threadId);
              setInput("");
              useAgentStream.getState().reset();
            } catch {
              /* keep silent — UI stays on prior thread */
            }
          }}
          title={t("session.newButton")}
          style={{
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "none",
            background: "#5D3000",
            color: "#FAF8F6",
            padding: "8px 14px",
            borderRadius: 999,
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 500,
            fontSize: 12.5,
            boxShadow: "0 2px 6px rgba(93,48,0,.22)",
            transition: "background .14s, transform .14s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#3F1F00";
            e.currentTarget.style.transform = "translateY(-1px)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#5D3000";
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {tChat("newSession")}
        </button>
        {/* Exit chat pill — clearly labelled so users always have an
            obvious way out of the fullscreen chat surface. Esc also fires
            the same handler (see effect above). */}
        <button
          type="button"
          onClick={() => router.push("/app/today")}
          title={tChat("exit")}
          style={{
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            border: "1px solid #EDE8DF",
            background: "#FFFFFF",
            color: "#5D3000",
            padding: "8px 14px",
            borderRadius: 999,
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 500,
            fontSize: 12.5,
            transition: "background .14s, border-color .14s, transform .14s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#FBF8F3";
            e.currentTarget.style.borderColor = "#5D3000";
            e.currentTarget.style.transform = "translateY(-1px)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#FFFFFF";
            e.currentTarget.style.borderColor = "#EDE8DF";
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
          {tChat("exit")}
          <span
            className="ds-mono-9"
            style={{
              padding: "1px 5px",
              border: "1px solid #E8DCCA",
              borderRadius: 4,
              color: "#A39F99",
              background: "#FBF8F3",
            }}
          >
            {t("fullscreen.exitHint")}
          </span>
        </button>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "32px 32px 24px",
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {!hasSteps ? (
            <div className="animate-fade-up">
              <div className="ds-mono-10" style={{ marginBottom: 10 }}>
                {t("greeting.today", { date: headerDate })}
              </div>
              <h1 className="ds-h2" style={{ margin: "0 0 10px", color: "#2B2822" }}>
                {t("greeting.headline", { greeting, name: who })}
              </h1>
              <p className="ds-body-sm" style={{ color: "#6B6560", margin: "0 0 18px" }}>
                {tChat("intro")}
              </p>
            </div>
          ) : (
            <StepTimeline scrollRef={scrollRef} />
          )}
        </div>
      </div>

      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid #EDE8DF",
          background: "#FBF8F3",
          padding: "12px 32px 18px",
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto", position: "relative" }}>
          <SlashPalette
            open={slashOpen}
            query={slashQuery}
            onClose={() => {
              setSlashOpen(false);
              slashRangeRef.current = null;
            }}
            onPick={handleSlashPick}
            onCommand={handleSlashCommand}
            variant="wide"
          />

          {(attachments.length > 0 || uploading || uploadError) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {attachments.map((a) => (
                <span
                  key={a.id}
                  title={`${a.name} · ${formatBytes(a.sizeBytes)}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "#FFFFFF",
                    border: "1px solid #E8DCCA",
                    borderRadius: 8,
                    padding: "5px 8px 5px 10px",
                    fontFamily: "Inter, system-ui, sans-serif",
                    fontSize: 12,
                    color: "#2B2822",
                    maxWidth: 240,
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => useDock.getState().removeAttachment(a.id)}
                    aria-label={t("composer.removeNamed", { name: a.name })}
                    title={t("composer.remove")}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: "#A39F99",
                      padding: 0,
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              {uploadError && (
                <span role="alert" style={{ fontFamily: "Inter", fontSize: 11.5, color: "#A23A2E", padding: "5px 4px" }}>
                  {uploadError}
                </span>
              )}
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              background: "#FFFFFF",
              border: focused ? "1px solid rgba(93,48,0,.28)" : "1px solid rgba(40,25,5,.07)",
              borderRadius: 22,
              padding: "14px 16px 10px",
              boxShadow: focused
                ? "0 1px 2px rgba(40,25,5,.05), 0 12px 36px rgba(40,25,5,.10)"
                : "0 1px 2px rgba(40,25,5,.04), 0 8px 28px rgba(40,25,5,.06)",
              transition: "border-color .18s ease, box-shadow .18s ease",
            }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={t("composer.placeholder")}
              rows={1}
              style={{
                width: "100%",
                border: "none",
                outline: "none",
                resize: "none",
                background: "transparent",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 15,
                lineHeight: 1.55,
                color: "#2B2822",
                maxHeight: 220,
                minHeight: 24,
                padding: 0,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACH_ACCEPT}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || streaming}
                title={t("composer.attachFile")}
                aria-label={t("composer.attachFile")}
                style={iconBtnStyle(uploading || streaming)}
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSlashOpen(true);
                  setSlashQuery("");
                  const el = textareaRef.current;
                  if (el) {
                    const caret = el.selectionStart ?? input.length;
                    slashRangeRef.current = { start: caret, end: caret };
                  }
                }}
                disabled={streaming}
                title={t("slash.label")}
                aria-label={t("slash.label")}
                style={iconBtnStyle(streaming)}
              >
                <span
                  aria-hidden
                  style={{
                    fontFamily: "JetBrains Mono, ui-monospace, monospace",
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                >
                  /
                </span>
              </button>

              {!hasContent && speechSupported ? (
                <button
                  type="button"
                  onClick={() => (listening ? stopListening() : startListening())}
                  disabled={streaming}
                  title={listening ? t("composer.stopVoice") : t("composer.voiceInput")}
                  aria-label={listening ? t("composer.stopVoice") : t("composer.voiceInput")}
                  aria-pressed={listening}
                  style={iconBtnStyle(streaming, listening)}
                >
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="2" width="6" height="12" rx="3" />
                    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
                  </svg>
                </button>
              ) : null}

              <div style={{ flex: 1 }} />

              {hasContent && !sendDisabled ? (
                <span className="ds-mono-9" aria-hidden="true" style={{ color: "#A39F99", marginRight: 6 }}>
                  ↵
                </span>
              ) : null}

              <button
                type="button"
                onClick={submit}
                disabled={sendDisabled}
                style={{
                  cursor: sendDisabled ? "not-allowed" : "pointer",
                  border: "none",
                  background: sendDisabled ? "#F0E8DA" : "#5D3000",
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "background .18s ease, transform .18s ease",
                  boxShadow: sendDisabled ? "none" : "0 2px 6px rgba(93,48,0,.22)",
                }}
                aria-label={sendDisabled ? t("composer.sendAriaDisabled") : t("composer.sendAria")}
                title={sendDisabled ? t("composer.sendTitleDisabled") : t("composer.sendTitle")}
              >
                <svg
                  width={15}
                  height={15}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={sendDisabled ? "#B8AE9C" : "#FAF8F6"}
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: "translateY(-1px)" }}
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function iconBtnStyle(disabled: boolean, active?: boolean): React.CSSProperties {
  return {
    cursor: disabled ? "not-allowed" : "pointer",
    background: active ? "#F5EDE3" : "transparent",
    border: "none",
    width: 32,
    height: 32,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: active ? "#5D3000" : disabled ? "#D6CEC0" : "#8C857C",
    transition: "background .18s ease, color .18s ease",
  };
}
