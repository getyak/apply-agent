"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useVantage } from "@/lib/store";
import {
  getToken,
  auth as authApi,
  resumes as resumesApi,
  ask as askApi,
} from "@/lib/api";
import { Sidebar } from "@/components/layout/sidebar";
import { OnboardingBanner } from "@/components/onboarding-banner";
import { OnboardingTour } from "@/components/onboarding-tour";
import { OnboardingScreen } from "@/components/screens/onboarding";
import { ReviewScreen } from "@/components/screens/review";
import { ExtensionScreen } from "@/components/screens/extension";
import { BuilderScreen } from "@/components/screens/builder";
import { MockScreen } from "@/components/screens/mock-interview";
import { PrepModal } from "@/components/screens/prep-modal";
import { AskVantageDock } from "@/components/ask-vantage/dock";
import {
  bootDockThread,
  hydrateDockFromStorage,
  useDock,
} from "@/lib/ask-vantage-store";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const screen = useVantage((s) => s.screen);
  const nav = useVantage((s) => s.nav);
  const prepId = useVantage((s) => s.prepId);
  const resumeWorkspace = useVantage((s) => s.resumeWorkspace);
  const currentUser = useVantage((s) => s.currentUser);
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  // Bring the dock back online on first mount: read persisted width/state
  // from localStorage and bind the persistent thread_id to the current user.
  // Mounting the dock in <AppLayout> is what gives it cross-route persistence.
  useEffect(() => {
    hydrateDockFromStorage();
  }, []);
  useEffect(() => {
    bootDockThread(currentUser?.id ?? null);
  }, [currentUser?.id]);

  // Hydrate the dock's RECENT rail from the server every time the user
  // (re)resolves. Done in parallel with bootDockThread so the rail
  // appears as soon as auth lands — feels instant on tab return.
  // Anonymous threads have no server-side history, so we skip the fetch
  // entirely and leave the rail in its empty state.
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    askApi
      .recent(10)
      .then((res) => {
        if (cancelled) return;
        useDock.getState().setRecentAnchors(res.items);
      })
      .catch((err) => {
        // Recent rail is informational; failing to load shouldn't block
        // the dock. Log so we notice in dev but otherwise stay silent.
        console.warn("[ask] recent fetch failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  // Mock live wants a quiet stage. Per vantage-ui-mapping.md §3.6 the dock
  // should collapse *when entering the live stage*, not on the whole mock
  // screen — the user still picks a mode and reads the intel brief with the
  // dock available. MockScreen now owns hintedCollapse for its live stage.
  // Layout's only job is the safety net: when the mock screen unmounts
  // (back to workspace), make sure the dock is restored even if MockScreen
  // crashed before its own cleanup ran.
  useEffect(() => {
    if (screen !== "mock") {
      useDock.getState().setHintedCollapse(false);
    }
  }, [screen]);

  // Store ↔ URL sync. Overlay-close store actions (backHome, closeExt,
  // submitReview, extSubmit, runFlow, enterApp) flip `screen` back to "app" and
  // set `nav` to chat|today|apps. We mirror that into the URL so the address
  // bar, back button, and refresh all stay coherent.
  //
  // Skip the redirect when the user is already on a sub-route that has its
  // own page.tsx (studio/*, interviews, etc.) — those are reachable directly
  // by URL and aren't represented in the `nav` enum. Without this guard,
  // refreshing or deep-linking into /app/studio/resume bounces back to /app/chat.
  useEffect(() => {
    if (!ready || screen !== "app") return;
    const current = typeof window !== "undefined" ? window.location.pathname : "";
    const isNavRoute =
      current === "/app/chat" ||
      current === "/app/today" ||
      current === "/app/applications" ||
      current === "/app/settings";
    if (!isNavRoute) return;
    const target =
      nav === "chat"
        ? "/app/chat"
        : nav === "today"
          ? "/app/today"
          : nav === "settings"
            ? "/app/settings"
            : "/app/applications";
    if (current !== target) router.replace(target);
  }, [ready, screen, nav, router]);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace("/auth");
      return;
    }
    let cancelled = false;
    // Hard ceiling: if me() never resolves (network hang, dev HMR jam), bounce
    // back to /auth with a reason so the user is not stuck on the spinner.
    const timeout = setTimeout(() => {
      if (!cancelled) router.replace("/auth?reason=session_timeout");
    }, 8000);
    authApi
      .me()
      .then(async () => {
        if (cancelled) return;
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
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/auth?reason=session_expired");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [router, resumeWorkspace]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-[var(--paper)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="font-display text-[18px] font-bold tracking-[3px] text-brown">
            VANTAGE
          </div>
          <p className="font-mono text-[12px] tracking-[0.5px] uppercase text-ink-muted animate-pulse">
            Preparing your workspace…
          </p>
        </div>
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
  // We still render the dock on top so Ask Vantage stays one click away — it
  // self-collapses to launcher whenever mock-live is on the stage.
  // Overlay screens are full-bleed task-flows, but the dock is still part of
  // the workspace chrome — it must keep its right-side rail (vantage-ui-mapping
  // §0). Wrap each overlay in the same flex row used by the workspace below so
  // <AskVantageDock /> docks to the right instead of falling under the page.
  const overlayShell = (Screen: React.ComponentType) => (
    <div className="h-screen w-screen flex overflow-hidden bg-paper">
      <main className="flex-1 min-w-0 overflow-y-auto">
        <Screen />
      </main>
      <AskVantageDock />
    </div>
  );

  if (screen === "onboarding" && !onSettings) return overlayShell(OnboardingScreen);
  if (screen === "review") return overlayShell(ReviewScreen);
  if (screen === "extension") return overlayShell(ExtensionScreen);
  if (screen === "builder") return overlayShell(BuilderScreen);
  if (screen === "mock") return overlayShell(MockScreen);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-paper">
      <OnboardingBanner />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
        <AskVantageDock />
      </div>
      <OnboardingTour />
      {prepId !== null && <PrepModal />}
    </div>
  );
}
