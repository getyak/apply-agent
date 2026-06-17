"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useVantage } from "@/lib/store";
import { getToken, auth as authApi } from "@/lib/api";
import { OnboardingScreen } from "@/components/screens/onboarding";
import { AppShell } from "@/components/screens/app-shell";
import { ReviewScreen } from "@/components/screens/review";
import { ExtensionScreen } from "@/components/screens/extension";
import { BuilderScreen } from "@/components/screens/builder";
import { MockScreen } from "@/components/screens/mock-interview";
import { PrepModal } from "@/components/screens/prep-modal";

export default function AppPage() {
  const screen = useVantage((s) => s.screen);
  const prepId = useVantage((s) => s.prepId);
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace("/auth");
      return;
    }
    authApi.me().then(() => setReady(true)).catch(() => {
      router.replace("/auth");
    });
  }, [router]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-[var(--paper)] flex items-center justify-center">
        <p className="text-[var(--ink)]/40 animate-pulse">Loading...</p>
      </div>
    );
  }

  return (
    <>
      {screen === "onboarding" && <OnboardingScreen />}
      {screen === "app" && <AppShell />}
      {screen === "review" && <ReviewScreen />}
      {screen === "extension" && <ExtensionScreen />}
      {screen === "builder" && <BuilderScreen />}
      {screen === "mock" && <MockScreen />}
      {prepId !== null && <PrepModal />}
    </>
  );
}
