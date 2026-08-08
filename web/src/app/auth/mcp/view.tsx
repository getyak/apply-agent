"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight, Bot, Check, ShieldCheck, X } from "lucide-react";
import {
  getToken,
  mcpOAuth,
  type McpAuthorizationRequest,
} from "@/lib/api";
import { BrandLoader, Button } from "@/components/ui";

const SCOPE_KEYS: Record<string, string> = {
  "career:read": "careerRead",
  "career:write": "careerWrite",
  "resume:publish": "resumePublish",
  "application:prepare": "applicationPrepare",
};

export default function McpAuthorizationView({
  requestId,
}: {
  requestId: string;
}) {
  const router = useRouter();
  const t = useTranslations("mcpAuth");
  const [request, setRequest] = useState<McpAuthorizationRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (!requestId) {
      queueMicrotask(() => setError(t("invalidRequest")));
      return;
    }
    if (!getToken()) {
      const next = `/auth/mcp?request_id=${encodeURIComponent(requestId)}`;
      router.replace(`/auth?next=${encodeURIComponent(next)}`);
      return;
    }

    let cancelled = false;
    mcpOAuth
      .request(requestId)
      .then(({ request: value }) => {
        if (!cancelled) setRequest(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t("loadFailed"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, router, t]);

  const decide = async (value: "approve" | "deny") => {
    setDecision(value);
    setError(null);
    try {
      const { redirectUrl } = await mcpOAuth.decide(requestId, value);
      window.location.assign(redirectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("decisionFailed"));
      setDecision(null);
    }
  };

  if (!request && !error) {
    return <BrandLoader label={t("loading")} />;
  }

  return (
    <main
      className="relative min-h-screen overflow-hidden px-4 py-12 flex items-center justify-center"
      style={{
        background:
          "radial-gradient(120% 120% at 50% 0%, #FFFFFF 0%, var(--color-paper) 55%, var(--color-cream) 100%)",
      }}
    >
      <div
        aria-hidden
        className="aurora-blob w-[420px] h-[420px] -top-[120px] -left-[80px] opacity-40"
      />
      <section className="relative w-full max-w-lg rounded-[16px] border border-border bg-white p-7 shadow-md animate-fade-up">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-cream text-brown">
            <Bot size={22} aria-hidden />
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[1.2px] text-ink-muted">
              {t("eyebrow")}
            </p>
            <h1 className="mt-1 font-display text-[26px] font-bold text-ink">
              {t("title")}
            </h1>
          </div>
        </div>

        {error ? (
          <div
            role="alert"
            className="mt-6 rounded-[12px] border border-cream-border bg-gold-bg px-4 py-3 font-body text-[14px] text-amber"
          >
            {error}
          </div>
        ) : request ? (
          <>
            <p className="mt-6 font-body text-[15px] leading-6 text-ink-light">
              {t("requestCopy", { client: request.client.name })}
            </p>

            <div className="mt-5 rounded-[12px] border border-border bg-paper px-4 py-4">
              <p className="font-body text-[13px] font-semibold text-ink">
                {t("permissions")}
              </p>
              <ul className="mt-3 space-y-3">
                {request.scopes.map((scope) => (
                  <li
                    key={scope}
                    className="flex items-start gap-3 font-body text-[13px] leading-5 text-ink-light"
                  >
                    <Check
                      size={16}
                      className="mt-0.5 shrink-0 text-brown"
                      aria-hidden
                    />
                    {SCOPE_KEYS[scope]
                      ? t(`scopes.${SCOPE_KEYS[scope]}`)
                      : scope}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-4 flex items-start gap-3 rounded-[12px] bg-cream/60 px-4 py-3">
              <ShieldCheck
                size={18}
                className="mt-0.5 shrink-0 text-brown"
                aria-hidden
              />
              <p className="font-body text-[12px] leading-5 text-ink-light">
                {t("safety")}
              </p>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Button
                variant="secondary"
                size="lg"
                disabled={decision !== null}
                leadingIcon={<X size={16} aria-hidden />}
                onClick={() => void decide("deny")}
              >
                {decision === "deny" ? t("denying") : t("deny")}
              </Button>
              <Button
                size="lg"
                disabled={decision !== null}
                trailingIcon={<ArrowRight size={16} aria-hidden />}
                onClick={() => void decide("approve")}
              >
                {decision === "approve" ? t("approving") : t("approve")}
              </Button>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
