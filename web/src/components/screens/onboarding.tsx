"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import {
  Upload,
  MessageSquare,
  ClipboardPaste,
  Link,
  FileText,
  ArrowRight,
  Sparkles,
  AlertCircle,
} from "lucide-react";
import { useVantage, type OnboardMethod } from "@/lib/store";
import { Button } from "@/components/ui";

const METHODS: { key: OnboardMethod; labelKey: string; Icon: typeof Upload }[] = [
  { key: "upload", labelKey: "method.upload", Icon: Upload },
  { key: "chat", labelKey: "method.chat", Icon: MessageSquare },
  { key: "paste", labelKey: "method.paste", Icon: ClipboardPaste },
  { key: "link", labelKey: "method.link", Icon: Link },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-brown">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FAF8F6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <span className="font-display text-[18px] font-bold tracking-[3px] text-brown">VANTAGE</span>
    </div>
  );
}

function IdleState() {
  const t = useTranslations("onboarding");
  const onboardMethod = useVantage((s) => s.onboardMethod);
  const setOnboardMethod = useVantage((s) => s.setOnboardMethod);
  const startByChat = useVantage((s) => s.startByChat);
  const parseFile = useVantage((s) => s.parseFile);
  const parsePastedText = useVantage((s) => s.parsePastedText);
  const uploadText = useVantage((s) => s.uploadText);
  const setUploadText = useVantage((s) => s.setUploadText);
  const parseError = useVantage((s) => s.parseError);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div
      className="flex min-h-screen w-full flex-col items-center justify-center px-6 py-16"
      style={{
        background:
          "radial-gradient(120% 120% at 50% 0%, #FFFFFF 0%, var(--color-paper) 55%, var(--color-cream) 100%)",
      }}
    >
      <div className="flex w-full max-w-[560px] flex-col items-center text-center">
        <div className="animate-fade-up">
          <Logo />
        </div>

        <h1 className="animate-fade-up mt-10 font-display text-[46px] font-bold leading-[1.08] -tracking-[0.5px] text-ink">
          {t("heroTitle")}
        </h1>

        <p className="animate-fade-up-delay mt-5 max-w-[420px] font-body text-[17px] leading-relaxed text-ink-light">
          {t("heroSubtitle")}
        </p>

        <div className="animate-fade-up-delay mt-9 flex items-center gap-2">
          {METHODS.map(({ key, labelKey, Icon }) => {
            const active = onboardMethod === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setOnboardMethod(key)}
                aria-pressed={active}
                className={
                  "rounded-full flex items-center gap-2 px-4 py-2 font-body text-[14px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper " +
                  (active
                    ? "bg-brown text-paper border border-transparent"
                    : "bg-white border border-border-dark text-ink-light hover:text-ink hover:border-brown")
                }
              >
                <Icon size={15} strokeWidth={2} />
                {t(labelKey)}
              </button>
            );
          })}
        </div>

        <div className="animate-fade-up-delay mt-6 w-full">
          {onboardMethod === "upload" && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) parseFile(f);
                  e.target.value = ""; // allow re-selecting the same file
                }}
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="group flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border-dark bg-white/60 px-8 py-12 transition-colors hover:border-brown hover:bg-white"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cream text-amber">
                  <FileText size={22} strokeWidth={1.75} />
                </div>
                <span className="font-display text-[17px] font-medium text-ink">{t("upload.title")}</span>
                <span className="font-body text-[13px] text-ink-muted">{t("upload.hint")}</span>
              </button>
            </>
          )}

          {onboardMethod === "chat" && (
            <div className="flex w-full flex-col items-center gap-4 rounded-2xl border border-border bg-white px-8 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gold-bg text-amber">
                <Sparkles size={22} strokeWidth={1.75} />
              </div>
              <p className="font-display text-[17px] font-medium text-ink">{t("chat.title")}</p>
              <p className="max-w-[360px] font-body text-[13px] text-ink-light">
                {t("chat.desc")}
              </p>
              <Button
                type="button"
                onClick={startByChat}
                size="md"
                className="mt-1 !rounded-full"
                trailingIcon={<ArrowRight size={15} strokeWidth={2} />}
              >
                {t("chat.cta")}
              </Button>
            </div>
          )}

          {onboardMethod === "paste" && (
            <div className="flex w-full flex-col gap-4 rounded-2xl border border-border bg-white p-5">
              <textarea
                value={uploadText}
                onChange={(e) => setUploadText(e.target.value)}
                placeholder={t("paste.placeholder")}
                className="h-40 w-full resize-none rounded-xl border border-border bg-paper px-4 py-3 font-body text-[14px] text-ink outline-none placeholder:text-ink-muted focus:border-border-dark"
              />
              <Button
                type="button"
                onClick={() => parsePastedText(uploadText)}
                disabled={uploadText.trim().length < 20}
                size="md"
                className="self-end !rounded-full"
                trailingIcon={<ArrowRight size={15} strokeWidth={2} />}
              >
                {t("paste.cta")}
              </Button>
            </div>
          )}

          {onboardMethod === "link" && (
            <div className="flex w-full flex-col gap-4 rounded-2xl border border-border bg-white p-5">
              <input
                type="url"
                placeholder="https://linkedin.com/in/your-profile"
                className="w-full rounded-xl border border-border bg-paper px-4 py-3 font-body text-[14px] text-ink outline-none placeholder:text-ink-muted focus:border-border-dark"
                disabled
              />
              <p className="text-left font-body text-[12px] text-ink-muted">
                {t("link.comingSoon")}
              </p>
            </div>
          )}
        </div>

        {parseError && (
          <div className="animate-fade-up mt-4 flex w-full items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-left">
            <AlertCircle size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-red-500" />
            <p className="font-body text-[13px] text-red-700">{parseError}</p>
          </div>
        )}

        <p className="animate-fade-up-delay mt-8 font-mono text-[11px] text-ink-muted">
          {t("privacyNote")}
        </p>
      </div>
    </div>
  );
}

export function OnboardingScreen() {
  // Parsing is now asynchronous: uploading a résumé takes the user straight
  // into the workspace (see store.parseFile → _startAsyncParse → enterApp),
  // where a non-blocking banner reports progress. The onboarding screen only
  // renders the idle entry; the upload itself is the sole brief wait, and any
  // upload error is surfaced inline here.
  return <IdleState />;
}
