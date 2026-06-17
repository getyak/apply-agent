"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { auth as authApi, setToken } from "@/lib/api";

export default function AuthPage() {
  const router = useRouter();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="min-h-screen bg-[var(--paper)] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-[var(--ink)]">
            VANTAGE
          </h1>
          <p className="text-[var(--ink)]/50 mt-2">
            {isLogin ? "Sign in to your account" : "Create your account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <div>
              <label className="block text-sm font-medium text-[var(--ink)]/70 mb-1">
                Display name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-[var(--ink)]/10 bg-white text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--brown)]/30"
                placeholder="Jordan Avery"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[var(--ink)]/70 mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl border border-[var(--ink)]/10 bg-white text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--brown)]/30"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--ink)]/70 mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full px-4 py-3 rounded-xl border border-[var(--ink)]/10 bg-white text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--brown)]/30"
              placeholder="••••••"
            />
          </div>

          {error && (
            <p className="text-red-500 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-[var(--ink)] text-[var(--paper)] font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? "..." : isLogin ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="text-center mt-6 text-sm text-[var(--ink)]/50">
          {isLogin ? "Don't have an account?" : "Already have an account?"}{" "}
          <button
            onClick={() => { setIsLogin(!isLogin); setError(""); }}
            className="text-[var(--brown)] hover:underline font-medium"
          >
            {isLogin ? "Sign up" : "Sign in"}
          </button>
        </p>

        <p className="text-center mt-4 text-xs text-[var(--ink)]/30">
          <Link href="/" className="hover:underline">← Back to home</Link>
        </p>
      </div>
    </div>
  );
}
