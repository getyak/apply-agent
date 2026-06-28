"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { auth as authApi, setToken, getToken } from "@/lib/api";
import { BrandLoader, Button, Field, Input } from "@/components/ui";
import { resolveError, type ResolvedError } from "@/lib/errors/resolve";
import { ErrorInline } from "@/components/errors";

// Next 16 requires components that read URL search params to be wrapped in a
// Suspense boundary so the rest of the page can be prerendered. Without it,
// `next build` fails the /auth route with "useSearchParams() should be wrapped
// in a suspense boundary". The fallback mirrors the same brand frame the inner
// component shows while verifying the session.
function AuthFallback() {
  const t = useTranslations("auth");
  return <BrandLoader label={t("loading")} />;
}

export default function AuthPage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <AuthPageInner />
    </Suspense>
  );
}

function AuthPageInner() {
  const router = useRouter();
  const t = useTranslations("auth");
  const search = useSearchParams();
  const sessionNotice = useMemo(() => {
    const reason = search?.get("reason");
    if (reason === "session_expired")
      return t("notice.sessionExpired");
    if (reason === "session_timeout")
      return t("notice.sessionTimeout");
    return null;
  }, [search, t]);
  // Landing CTAs hand off plan / mode / intent via query so the auth page can
  // open in the right state and remember the user's pricing choice on signup.
  const planLabel = useMemo(() => {
    const plan = search?.get("plan");
    if (plan === "pro") return t("plan.pro");
    if (plan === "max") return t("plan.max");
    if (plan === "free") return t("plan.free");
    return null;
  }, [search, t]);
  const initialMode = useMemo(() => {
    const mode = search?.get("mode");
    // mode=login → sign-in form; mode=signup or any plan/intent → sign-up form.
    if (mode === "signup") return false;
    if (mode === "login") return true;
    if (search?.get("plan") || search?.get("intent")) return false;
    return true;
  }, [search]);
  const [isLogin, setIsLogin] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  /**
   * Two-track error state:
   *   - `resolvedError` — the typed result from resolveError() that the
   *     <ErrorInline /> component renders. This is the right channel
   *     for anything coming from the API (envelope v2).
   *   - we DON'T fall back to a raw string anymore — if resolveError
   *     can't classify the thrown value it returns a synthetic
   *     INTERNAL ResolvedError, which renders the localised
   *     "Unexpected error" copy. No more "Something went wrong".
   */
  const [resolvedError, setResolvedError] = useState<ResolvedError | null>(null);
  const [loading, setLoading] = useState(false);
  // Forward guard: if already signed in, skip the form and go straight to the app.
  // Default to false so SSR renders the form directly; if hydration silently fails
  // (e.g. dev HMR ws drops), the user still has a working form. Only flip to true
  // *after* we observe a token and start verifying it.
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setChecking(true);
    });
    const timeout = setTimeout(() => {
      if (!cancelled) setChecking(false);
    }, 5000);
    authApi
      .me()
      .then(() => {
        if (!cancelled) router.replace("/app");
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResolvedError(null);
    setLoading(true);
    try {
      if (isLogin) {
        const { token } = await authApi.login(email, password);
        setToken(token);
      } else {
        const { token } = await authApi.register(email, password, name || undefined);
        setToken(token);
      }
      router.push("/app");
    } catch (err) {
      // The error router (web/src/lib/errors/resolve.ts) maps every
      // ApiError code into a typed ResolvedError carrying its own
      // localized title/body + the matrix-decided CTAs. Auth-page
      // context tells the router to favor inline rendering (under the
      // form) over a toast — see error-handling.md §4.3.3.
      setResolvedError(resolveError(err, { page: "auth", inForm: true }));
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return <BrandLoader label={t("verifying")} />;
  }

  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4"
      style={{
        background:
          "radial-gradient(120% 120% at 50% 0%, #FFFFFF 0%, var(--color-paper) 55%, var(--color-cream) 100%)",
      }}
    >
      {/* Warm aurora drift behind the card — the same depth the landing hero
          carries, so the first authenticated surface doesn't read flat. */}
      <div
        aria-hidden
        className="aurora-blob w-[420px] h-[420px] -top-[120px] -left-[80px] opacity-40"
      />
      <div
        aria-hidden
        className="aurora-blob w-[320px] h-[320px] -bottom-[120px] -right-[60px] opacity-30 [animation-delay:-7s]"
      />
      <div className="relative w-full max-w-md animate-fade-up">
        <div className="text-center mb-8">
          <div className="font-display text-[18px] font-bold tracking-[3px]">
            <span className="gradient-text">VANTAGE</span>
          </div>
          <h1 className="mt-4 font-display text-[32px] font-bold -tracking-[0.3px] text-ink leading-tight">
            {isLogin ? t("welcomeBack") : t("startHunt")}
          </h1>
          <p className="mt-2 font-body text-[14px] text-ink-light">
            {isLogin ? t("signInSub") : t("signUpSub")}
          </p>
        </div>

        {sessionNotice && (
          <p
            role="status"
            className="mb-4 font-body text-[13px] text-amber bg-gold-bg border border-cream-border rounded-[10px] px-3 py-2 text-center"
          >
            {sessionNotice}
          </p>
        )}
        {planLabel && !sessionNotice && (
          <p
            role="status"
            className="mb-4 font-body text-[13px] text-brown bg-cream border border-cream-border rounded-[10px] px-3 py-2 text-center"
          >
            {planLabel}
          </p>
        )}

        <form
          onSubmit={handleSubmit}
          onPointerMove={(e) => {
            // Feed the cursor position to the `.glow-track` spotlight so the
            // warm highlight follows the pointer across the card. No state, no
            // re-render — written straight to style for 60fps cheapness.
            const el = e.currentTarget;
            const r = el.getBoundingClientRect();
            el.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
            el.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
          }}
          className="glow-track spotlight animate-pop-blur stagger space-y-4 bg-white border border-border rounded-[14px] p-6 shadow-md"
        >
          {!isLogin && (
            <Field label={t("displayName")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("displayNamePlaceholder")}
                autoComplete="name"
              />
            </Field>
          )}

          <Field label={t("email")}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              autoComplete="email"
            />
          </Field>

          <Field label={t("password")} hint={isLogin ? undefined : t("passwordHint")}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              placeholder="••••••"
              autoComplete={isLogin ? "current-password" : "new-password"}
            />
          </Field>

          {resolvedError && (
            <ErrorInline
              resolved={resolvedError}
              onCta={(cta) => {
                if (cta.id === "reauth") {
                  // Already on the auth page — clearing the form is the
                  // friendliest take. The user can just type their
                  // creds again.
                  setResolvedError(null);
                  setPassword("");
                } else if (cta.id === "dismiss") {
                  setResolvedError(null);
                }
              }}
            />
          )}

          <Button
            type="submit"
            disabled={loading}
            fullWidth
            size="lg"
            trailingIcon={!loading ? <ArrowRight size={16} strokeWidth={2} /> : null}
          >
            {loading ? "…" : isLogin ? t("signIn") : t("createAccount")}
          </Button>
        </form>

        <p className="text-center mt-6 font-body text-[14px] text-ink-light">
          {isLogin ? t("noAccount") : t("haveAccount")}{" "}
          <button
            type="button"
            onClick={() => {
              setIsLogin(!isLogin);
              setResolvedError(null);
            }}
            className="text-brown font-semibold hover:underline outline-none focus-visible:ring-2 focus-visible:ring-brown rounded"
          >
            {isLogin ? t("signUp") : t("signIn")}
          </button>
        </p>

        <p className="text-center mt-4 font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
          <Link href="/" className="inline-flex items-center gap-1 hover:text-ink transition-colors">
            <ArrowLeft size={11} /> {t("backToHome")}
          </Link>
        </p>
      </div>
    </div>
  );
}
