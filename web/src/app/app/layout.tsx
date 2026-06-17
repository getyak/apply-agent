"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useVantage } from "@/lib/store";
import { getToken, auth as authApi, resumes as resumesApi } from "@/lib/api";
import { Sidebar } from "@/components/layout/sidebar";
import { OnboardingBanner } from "@/components/onboarding-banner";
import { OnboardingTour } from "@/components/onboarding-tour";
import { OnboardingScreen } from "@/components/screens/onboarding";
import { ReviewScreen } from "@/components/screens/review";
import { ExtensionScreen } from "@/components/screens/extension";
import { BuilderScreen } from "@/components/screens/builder";
import { MockScreen } from "@/components/screens/mock-interview";
import { PrepModal } from "@/components/screens/prep-modal";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const screen = useVantage((s) => s.screen);
  const nav = useVantage((s) => s.nav);
  const prepId = useVantage((s) => s.prepId);
  const resumeWorkspace = useVantage((s) => s.resumeWorkspace);
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  // Store ↔ URL sync. Overlay-close store actions (backHome, closeExt,
  // submitReview, extSubmit, runFlow, enterApp) flip `screen` back to "app" and
  // set `nav` to chat|today|apps. We mirror that into the URL so the address
  // bar, back button, and refresh all stay coherent.
  useEffect(() => {
    if (!ready || screen !== "app") return;
    const target =
      nav === "chat"
        ? "/app/chat"
        : nav === "today"
          ? "/app/today"
          : nav === "settings"
            ? "/app/settings"
            : "/app/applications";
    if (typeof window !== "undefined" && window.location.pathname !== target) {
      router.replace(target);
    }
  }, [ready, screen, nav, router]);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace("/auth");
      return;
    }
    authApi
      .me()
      .then(async () => {
        try {
          // API returns the offset-paginated envelope { data, page }; tolerate
          // the legacy { resumes } shape during rollout.
          const res = await resumesApi.list();
          const resumes =
            (res as { data?: Array<{ id: string; is_base: boolean }>; resumes?: Array<{ id: string; is_base: boolean }> })
              .data ??
            (res as { resumes?: Array<{ id: string; is_base: boolean }> }).resumes ??
            [];
          if (resumes.length > 0) {
            const base = resumes.find((r) => r.is_base) ?? resumes[0];
            resumeWorkspace(base.id);
          }
        } catch {
          // Returning user without a résumé falls through to onboarding;
          // brand-new users land on the "Your job hunt, handled" screen.
        }
        setReady(true);
      })
      .catch(() => {
        router.replace("/auth");
      });
  }, [router, resumeWorkspace]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-[var(--paper)] flex items-center justify-center">
        <p className="text-[var(--ink)]/40 animate-pulse">Loading...</p>
      </div>
    );
  }

  // Settings is account-level, not part of the résumé-first onboarding flow, so
  // it must stay reachable even before the user has uploaded a résumé (direct
  // visit / refresh on /app/settings, where `screen` is still "onboarding").
  // Render it under the normal workspace chrome instead of the onboarding gate.
  const onSettings = pathname === "/app/settings";

  // Overlay screens fully replace the workspace chrome; they're modal task-flows
  // scoped to one job and don't belong under the persistent sidebar layout.
  if (screen === "onboarding" && !onSettings) return <OnboardingScreen />;
  if (screen === "review") return <ReviewScreen />;
  if (screen === "extension") return <ExtensionScreen />;
  if (screen === "builder") return <BuilderScreen />;
  if (screen === "mock") return <MockScreen />;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-paper">
      <OnboardingBanner />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
      </div>
      <OnboardingTour />
      {prepId !== null && <PrepModal />}
    </div>
  );
}
