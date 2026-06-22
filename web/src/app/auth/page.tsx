"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { auth as authApi, setToken, getToken, ApiError } from "@/lib/api";
import { BrandLoader, Button, Field, Input } from "@/components/ui";

// Next 16 requires components that read URL search params to be wrapped in a
// Suspense boundary so the rest of the page can be prerendered. Without it,
// `next build` fails the /auth route with "useSearchParams() should be wrapped
// in a suspense boundary". The fallback mirrors the same brand frame the inner
// component shows while verifying the session.
function AuthFallback() {
  return <BrandLoader label="Loading…" />;
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
  const search = useSearchParams();
  const sessionNotice = useMemo(() => {
    const reason = search?.get("reason");
    if (reason === "session_expired")
      return "Your session has expired. Please sign in again.";
    if (reason === "session_timeout")
      return "Couldn't reach the server. Please try signing in again.";
    return null;
  }, [search]);
  // Landing CTAs hand off plan / mode / intent via query so the auth page can
  // open in the right state and remember the user's pricing choice on signup.
  const planLabel = useMemo(() => {
    const plan = search?.get("plan");
    if (plan === "pro") return "Continue to start your 7-day Pro trial.";
    if (plan === "max") return "Continue to go Max.";
    if (plan === "free") return "Continue to start free.";
    return null;
  }, [search]);
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
  const [error, setError] = useState("");
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
    setError("");
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
      // P3 (round-3): rate-limit responses (429) used to surface as the
      // backend's literal "Rate limit exceeded for auth. Try again in
      // 47s." string, which reads like a debug log and gets buried under
      // the generic "Invalid email or password" path the round-3
      // auth-audit flagged. Surface a friendlier line that still keeps
      // the retry-after window the backend computed.
      if (err instanceof ApiError && err.status === 429) {
        const match = err.message.match(/(\d+)\s*s/);
        const retrySeconds = match ? match[1] : null;
        setError(
          retrySeconds
            ? `Too many attempts. Please wait ${retrySeconds} seconds before trying again.`
            : "Too many attempts. Please wait a moment before trying again.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return <BrandLoader label="Verifying your session…" />;
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
            {isLogin ? "Welcome back." : "Start your hunt."}
          </h1>
          <p className="mt-2 font-body text-[14px] text-ink-light">
            {isLogin ? "Sign in to your workspace." : "It takes under a minute."}
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
            <Field label="Display name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What we should call you"
                autoComplete="name"
              />
            </Field>
          )}

          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              autoComplete="email"
            />
          </Field>

          <Field label="Password" hint={isLogin ? undefined : "6+ characters."}>
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

          {error && (
            <p
              role="alert"
              className="font-body text-[13px] text-amber bg-gold-bg border border-cream-border rounded-[10px] px-3 py-2"
            >
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={loading}
            fullWidth
            size="lg"
            trailingIcon={!loading ? <ArrowRight size={16} strokeWidth={2} /> : null}
          >
            {loading ? "…" : isLogin ? "Sign in" : "Create account"}
          </Button>
        </form>

        <p className="text-center mt-6 font-body text-[14px] text-ink-light">
          {isLogin ? "Don't have an account?" : "Already have an account?"}{" "}
          <button
            type="button"
            onClick={() => {
              setIsLogin(!isLogin);
              setError("");
            }}
            className="text-brown font-semibold hover:underline outline-none focus-visible:ring-2 focus-visible:ring-brown rounded"
          >
            {isLogin ? "Sign up" : "Sign in"}
          </button>
        </p>

        <p className="text-center mt-4 font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
          <Link href="/" className="inline-flex items-center gap-1 hover:text-ink transition-colors">
            <ArrowLeft size={11} /> Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
