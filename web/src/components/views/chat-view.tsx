"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useVantage } from "@/lib/store";
import { files as filesApi } from "@/lib/api";
import type { ChatAttachment } from "@/lib/store";
import { firstNameOf, fullGreeting, formatToday } from "@/lib/dates";
import {
  Check,
  Zap,
  CheckCircle2,
  Mic,
  Plus,
  Paperclip,
  ImageIcon,
  X,
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SUGGESTION_IDS = ["find", "tailor", "prep", "market"] as const;

export function ChatView() {
  const router = useRouter();
  const t = useTranslations("chat");
  const chatLog = useVantage((s) => s.chatLog);
  // `sendChat` was the empty-input demo trigger — removed per audit P1.
  // `runFlow` is still used by the suggestion chips (legacy demo flows
  // kept until P2 replaces chips with real ask-stream prompts).
  const runFlow = useVantage((s) => s.runFlow);
  const chatInput = useVantage((s) => s.chatInput);
  const setChatInput = useVantage((s) => s.setChatInput);
  const sendRealChat = useVantage((s) => s.sendRealChat);
  const chatAttachments = useVantage((s) => s.chatAttachments);
  const chatMessages = useVantage((s) => s.chatMessages);
  const chatLoading = useVantage((s) => s.chatLoading);
  const chatHydrating = useVantage((s) => s.chatHydrating);
  const currentUser = useVantage((s) => s.currentUser);
  const parsedResume = useVantage((s) => s.parsedResume);
  const loadCurrentUser = useVantage((s) => s.loadCurrentUser);
  const hydrateChat = useVantage((s) => s.hydrateChat);
  const hasLog = chatLog.length > 0 || chatMessages.length > 0;

  useEffect(() => {
    if (!currentUser) loadCurrentUser();
    // Replay any persisted conversation so it survives a reload (no-op if there
    // is no stored session or it's already loaded).
    hydrateChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstName =
    firstNameOf(parsedResume?.basics?.name) || firstNameOf(currentUser?.displayName);
  const headerDate = useMemo(() => formatToday(), []);
  const greeting = useMemo(() => fullGreeting(firstName), [firstName]);

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {chatHydrating && !hasLog && (
          <div className="max-w-[720px] mx-auto px-10 pt-[84px] flex items-center gap-[10px]">
            <div className="w-4 h-4 rounded-full border-2 border-[#F0E4D2] border-t-amber animate-spin shrink-0" />
            <span className="font-body text-[15px] text-ink-light animate-pulse">
              {t("loadingConversation")}
            </span>
          </div>
        )}

        {!hasLog && !chatHydrating && (
          <div className="max-w-[720px] mx-auto px-10 pt-[84px] pb-[30px] animate-fade-up">
            <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-3">
              {headerDate}
            </div>
            <h1 className="font-display font-bold text-[34px] -tracking-[0.4px] text-ink mb-2">
              {greeting}
            </h1>
            <p className="font-body text-[17px] leading-[1.5] text-ink-light mb-[30px]">
              {t("intro")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {SUGGESTION_IDS.map((id) => (
                <div
                  key={id}
                  onClick={() => runFlow(id)}
                  className="cursor-pointer bg-white border border-border rounded-[13px] px-[18px] py-4 flex items-center gap-3 shadow-sm hover:border-brown hover:-translate-y-px transition-all"
                >
                  <div className="w-8 h-8 rounded-[9px] bg-cream flex items-center justify-center shrink-0">
                    <Zap className="w-4 h-4 text-brown" strokeWidth={1.8} />
                  </div>
                  <span className="font-body font-medium text-[14.5px] text-ink">
                    {t(`suggestions.${id}`)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasLog && (
          <div className="max-w-[720px] mx-auto px-10 pt-9 pb-5 flex flex-col gap-[18px]">
            {chatLog.map((entry) => (
              <div key={entry.key} className="flex flex-col gap-3">
                <div className="flex justify-end w-full">
                  <div className="bg-brown text-paper font-body text-[15px] leading-[1.5] px-4 py-[10px] rounded-[13px] rounded-br-[4px] max-w-[460px]">
                    {t("demo.userMsg")}
                  </div>
                </div>

                <div className="flex gap-[10px] items-start">
                  <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                    <Check className="w-[15px] h-[15px] text-paper" strokeWidth={2.2} />
                  </div>
                  <div className="font-body text-[15px] leading-[1.55] text-ink max-w-[520px]">
                    {t("demo.onIt")}
                  </div>
                </div>

                <div className="flex gap-[10px] items-start">
                  <div className="w-[30px] shrink-0" />
                  <div className="flex flex-col gap-2 flex-1 max-w-[520px]">
                    <div className="flex items-center gap-[11px] bg-white border border-cream-border rounded-[10px] px-[14px] py-[11px]">
                      {entry.phase < 1 ? (
                        <div className="w-4 h-4 rounded-full border-2 border-[#F0E4D2] border-t-amber animate-spin shrink-0" />
                      ) : (
                        <div className="w-[22px] h-[22px] rounded-[6px] bg-cream flex items-center justify-center shrink-0">
                          <Zap className="w-[13px] h-[13px] text-brown" strokeWidth={2} />
                        </div>
                      )}
                      <span className="font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                        {t("demo.jobScanner")}
                      </span>
                      <span className={`ml-auto font-mono text-[10px] tracking-[0.5px] uppercase ${entry.phase < 1 ? "text-amber" : "text-green"}`}>
                        {entry.phase < 1 ? t("demo.scanning") : t("demo.done")}
                      </span>
                    </div>
                  </div>
                </div>

                {entry.phase >= 1 && (
                  <div className="flex gap-[10px] items-start">
                    <div className="w-[30px] shrink-0" />
                    <div className="flex-1 max-w-[520px] bg-[#FFFBF4] border border-cream-border rounded-[13px] px-[18px] py-4 flex items-center gap-[14px] animate-pop">
                      <div className="w-[38px] h-[38px] rounded-[10px] bg-green-bg flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-[19px] h-[19px] text-green" strokeWidth={2} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-body font-semibold text-[15px] text-ink">
                          {t("demo.rolesFound")}
                        </div>
                        <div className="font-body text-[13px] text-ink-light mt-[2px]">
                          {t("demo.readyToApply")}
                        </div>
                      </div>
                      <button
                        onClick={() => router.push("/app/today")}
                        className="cursor-pointer border-none bg-brown text-paper font-body font-semibold text-[13px] px-4 py-[10px] rounded-[9px] whitespace-nowrap shrink-0 hover:bg-brown-light transition-colors"
                      >
                        {t("demo.viewMatches")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatMessages.map((msg, i) => (
              <div key={`real-${i}`} className="flex flex-col gap-3 animate-rise">
                {msg.role === "user" ? (
                  <div className="flex flex-col items-end w-full gap-1.5">
                    <div className="bg-brown text-paper font-body text-[15px] leading-[1.5] px-4 py-[10px] rounded-[13px] rounded-br-[4px] max-w-[460px] whitespace-pre-wrap">
                      {msg.content}
                    </div>
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5 max-w-[460px]">
                        {msg.attachments.map((a) => (
                          <span
                            key={a.id}
                            title={`${a.name} · ${formatBytes(a.sizeBytes)}`}
                            className="inline-flex items-center gap-1.5 bg-white border border-cream-border rounded-lg pl-2 pr-2.5 py-1 max-w-[220px]"
                          >
                            {a.kind === "image" ? (
                              <ImageIcon className="w-3 h-3 text-brown shrink-0" strokeWidth={1.9} />
                            ) : (
                              <Paperclip className="w-3 h-3 text-brown shrink-0" strokeWidth={1.9} />
                            )}
                            <span className="font-body text-[12px] text-ink truncate">
                              {a.name}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex gap-[10px] items-start">
                    <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                      <Check className="w-[15px] h-[15px] text-paper" strokeWidth={2.2} />
                    </div>
                    <div className="font-body text-[15px] leading-[1.55] text-ink max-w-[520px] whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatLoading && (
              <div className="flex gap-[10px] items-start">
                <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                  <div className="w-4 h-4 rounded-full border-2 border-paper/30 border-t-paper animate-spin" />
                </div>
                <div className="font-body text-[15px] text-ink-light animate-pulse">
                  {t("thinking")}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-paper/90 backdrop-blur-xl px-10 py-4 pb-[22px]">
        <div className="max-w-[720px] mx-auto">
          {hasLog && (
            <div className="flex flex-wrap gap-2 mb-3">
              {SUGGESTION_IDS.map((id) => (
                <button
                  key={id}
                  onClick={() => runFlow(id)}
                  className="cursor-pointer bg-white border border-border-dark text-ink font-body font-medium text-[12.5px] px-[13px] py-[7px] rounded-full hover:border-brown hover:bg-[#FFFDFB] transition-all"
                >
                  {t(`suggestions.${id}`)}
                </button>
              ))}
            </div>
          )}
          {/* Dock-parity composer: rounded lifted card, auto-grow textarea,
              attachment chips, and a circular attach / mic / send button
              group — visually identical to the Ask Vantage dock so the two
              surfaces feel like one product. */}
          <ChatComposer
            value={chatInput}
            onChange={setChatInput}
            onSubmit={sendRealChat}
            attachments={chatAttachments}
            loading={chatLoading}
          />
        </div>
      </div>
    </div>
  );
}

// Minimal Web Speech API shape — same loose typing the dock uses so we stay
// off `any` without pulling a whole lib.dom diff.
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

// Accept the same doc types as the dock plus images (the /api/files/attachment
// route widens the allowlist). Keep the hidden <input>'s accept in sync.
const ATTACH_ACCEPT =
  ".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.gif," +
  "application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "text/plain,image/png,image/jpeg,image/webp,image/gif";

// Dock-parity composer for the main chat surface. Visual language matches
// components/ask-vantage/dock.tsx's composer: a lifted rounded card that
// warms on focus, an auto-grow textarea, attachment chips, and a circular
// attach / mic / send button group on the trailing edge.
function ChatComposer({
  value,
  onChange,
  onSubmit,
  attachments,
  loading,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  attachments: ChatAttachment[];
  loading: boolean;
}) {
  const t = useTranslations("chat");
  const addChatAttachment = useVantage((s) => s.addChatAttachment);
  const removeChatAttachment = useVantage((s) => s.removeChatAttachment);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const [focused, setFocused] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  // Auto-grow the textarea up to a ceiling, matching the dock.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [value]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* already stopped */
      }
    };
  }, []);

  const speechSupported = useMemo(() => getSpeechRecognitionCtor() !== null, []);

  async function handleFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const res = await filesApi.uploadAttachment(file);
      addChatAttachment({
        id: res.file.id,
        name: res.file.filename,
        sizeBytes: res.file.sizeBytes,
        kind: res.kind,
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  function startListening() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang =
      typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let transcript = "";
      const results = e.results;
      for (let i = 0; i < results.length; i++) {
        const alt = results[i][0];
        if (alt && typeof alt.transcript === "string") transcript += alt.transcript;
      }
      onChange(transcript.trimStart());
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

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const sendDisabled = loading || !hasContent;

  // Arm pulse — fire the one-shot spring pop the instant Send flips from
  // disabled → enabled, so the keystroke (or staged file) that made the message
  // valid gets a small reward. We compare against the previous value rather than
  // animating on every render so the pop only plays on the actual transition.
  const wasSendDisabled = useRef(sendDisabled);
  const [armPulse, setArmPulse] = useState(false);
  useEffect(() => {
    const flippedOn = wasSendDisabled.current && !sendDisabled;
    wasSendDisabled.current = sendDisabled;
    if (!flippedOn) return;
    setArmPulse(true);
    const t = setTimeout(() => setArmPulse(false), 440);
    return () => clearTimeout(t);
  }, [sendDisabled]);

  return (
    <div className="relative">
      {/* Attachment chips — only once the user has staged a file. */}
      {(attachments.length > 0 || uploading || uploadError) && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a) => (
            <span
              key={a.id}
              title={`${a.name} · ${formatBytes(a.sizeBytes)}`}
              className="animate-chip-pop inline-flex items-center gap-1.5 bg-white border border-cream-border rounded-lg pl-2.5 pr-1.5 py-1 max-w-[240px]"
            >
              {a.kind === "image" ? (
                <ImageIcon className="w-3 h-3 text-brown shrink-0" strokeWidth={1.9} />
              ) : (
                <Paperclip className="w-3 h-3 text-brown shrink-0" strokeWidth={1.9} />
              )}
              <span className="font-body text-[12px] text-ink truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => removeChatAttachment(a.id)}
                aria-label={t("removeAttachment", { name: a.name })}
                title={t("remove")}
                className="cursor-pointer text-ink-muted hover:text-ink shrink-0 flex items-center"
              >
                <X className="w-3 h-3" strokeWidth={2} />
              </button>
            </span>
          ))}
          {uploading && (
            <span className="animate-chip-pop inline-flex items-center gap-1.5 bg-[#FFFBF4] border border-dashed border-cream-border rounded-lg px-2.5 py-1 font-body text-[12px] text-brown">
              <span className="w-3 h-3 rounded-full border-2 border-[#F0E4D2] border-t-amber animate-spin" />
              {t("uploading")}
            </span>
          )}
          {uploadError && !uploading && (
            <span role="alert" className="font-body text-[11.5px] text-red px-1 py-1">
              {uploadError}
            </span>
          )}
        </div>
      )}

      <div
        className="flex flex-col gap-2.5 bg-white rounded-[22px] px-4 pt-3.5 pb-2.5 transition-[border-color,box-shadow] duration-200"
        style={{
          border: focused
            ? "1px solid rgba(93,48,0,.28)"
            : "1px solid rgba(40,25,5,.07)",
          boxShadow: focused
            ? "0 1px 2px rgba(40,25,5,.05), 0 12px 36px rgba(40,25,5,.10)"
            : "0 1px 2px rgba(40,25,5,.04), 0 8px 28px rgba(40,25,5,.06)",
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!sendDisabled) onSubmit();
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={t("composerPlaceholder")}
          rows={1}
          className="w-full resize-none bg-transparent border-none outline-none font-body text-[14.5px] leading-[1.55] text-ink placeholder:text-ink-muted"
          style={{ maxHeight: 160, minHeight: 22 }}
        />

        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACH_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />

          <CircleIconButton
            label={t("attachLabel")}
            disabled={uploading || loading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus className="w-[17px] h-[17px]" strokeWidth={2} />
          </CircleIconButton>

          {!hasContent && speechSupported && (
            <CircleIconButton
              label={listening ? t("voiceStop") : t("voiceStart")}
              disabled={loading}
              active={listening}
              ring={listening}
              onClick={() => (listening ? stopListening() : startListening())}
            >
              <Mic className="w-[15px] h-[15px]" strokeWidth={1.9} />
            </CircleIconButton>
          )}

          <div className="flex-1" />

          {hasContent && !sendDisabled && (
            <span className="font-mono text-[10px] text-ink-muted mr-1.5 select-none" aria-hidden>
              ↵
            </span>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={sendDisabled}
            aria-label={sendDisabled ? t("sendDisabledLabel") : t("send")}
            title={sendDisabled ? t("sendDisabledTitle") : t("sendTitle")}
            className={`${armPulse ? "animate-send-arm" : ""} w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-[background,transform,box-shadow] duration-200 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:-translate-y-px`}
            style={{
              background: sendDisabled ? "#F0E8DA" : "#5D3000",
              boxShadow: sendDisabled ? "none" : "0 2px 6px rgba(93,48,0,.22)",
            }}
          >
            <svg
              width={14}
              height={14}
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
  );
}

// Flat circular icon button — 32px hit target, matches the dock's trailing
// edge so attach / mic / send all read as metric siblings.
function CircleIconButton({
  label,
  onClick,
  disabled,
  active,
  ring,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  ring?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`${ring ? "mic-listening" : ""} relative w-8 h-8 rounded-full flex items-center justify-center transition-colors disabled:cursor-not-allowed enabled:cursor-pointer`}
      style={{
        background: active ? "#F5EDE3" : "transparent",
        color: active ? "#5D3000" : disabled ? "#D6CEC0" : "#8C857C",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = active ? "#F0E4D2" : "#F5EFE5";
        e.currentTarget.style.color = "#5D3000";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "#F5EDE3" : "transparent";
        e.currentTarget.style.color = active
          ? "#5D3000"
          : disabled
            ? "#D6CEC0"
            : "#8C857C";
      }}
    >
      {children}
    </button>
  );
}
