"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { auth as authApi, setToken, getToken } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";

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
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      queueMicrotask(() => setChecking(false));
      return;
    }
    authApi
      .me()
      .then(() => router.replace("/app"))
      .catch(() => queueMicrotask(() => setChecking(false)));
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
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <p className="font-mono text-[12px] tracking-[0.5px] uppercase text-ink-muted animate-pulse">
          Loading…
        </p>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        background:
          "radial-gradient(120% 120% at 50% 0%, #FFFFFF 0%, var(--color-paper) 55%, var(--color-cream) 100%)",
      }}
    >
      <div className="w-full max-w-md animate-fade-up">
        <div className="text-center mb-8">
          <div className="font-display text-[18px] font-bold tracking-[3px] text-brown">
            VANTAGE
          </div>
          <h1 className="mt-4 font-display text-[32px] font-bold -tracking-[0.3px] text-ink leading-tight">
            {isLogin ? "Welcome back." : "Start your hunt."}
          </h1>
          <p className="mt-2 font-body text-[14px] text-ink-light">
            {isLogin ? "Sign in to your workspace." : "It takes under a minute."}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 bg-white border border-border rounded-[14px] p-6 shadow-sm"
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
