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
import { BrandLoader } from "@/components/ui";
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
  installDockViewportWatcher,
  useDock,
} from "@/lib/ask-vantage-store";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const screen = useVantage((s) => s.screen);
  const nav = useVantage((s) => s.nav);
  const prepId = useVantage((s) => s.prepId);
  const resumeWorkspace = useVantage((s) => s.resumeWorkspace);
  const currentUser = useVantage((s) => s.currentUser);
  // After we confirm auth (me() resolves), populate the store's `resumes`
  // list so the persistent sidebar chip + dock résumé picker have data the
  // moment the workspace renders. Without this, returning users would only
  // see those surfaces after the first parse round-trip — defeating the
  // "ambient résumé context" goal of the post-upload UX upgrade.
  const loadResumes = useVantage((s) => s.loadResumes);
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  // Bring the dock back online on first mount: read persisted width/state
  // from localStorage and bind the persistent thread_id to the current user.
  // Mounting the dock in <AppLayout> is what gives it cross-route persistence.
  useEffect(() => {
    hydrateDockFromStorage();
  }, []);
  // M2 (round-4): keep the dock state honest under viewport changes
  // (window resize on desktop, rotation on tablet, browser dev-tools
  // opening). hydrateDockFromStorage() above only runs once on mount;
  // installDockViewportWatcher subscribes to the same matchMedia query
  // so transitions in/out of "narrow" auto-collapse / restore the dock.
  // Returns a teardown so HMR / route change / signOut cleanups don't
  // leak listeners.
  useEffect(() => installDockViewportWatcher(), []);
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

  // Hydrate the dock's STEP TIMELINE from the lifetime ask_vantage thread.
  // The dock now lives on a single per-user thread (vantage-ui-mapping §1.2),
  // so the persisted (user, assistant) turns belong on the timeline the
  // moment the dock opens — not "after the next send". Without this hydrate
  // every reload looked like a fresh window even though the server kept
  // every prior turn. Backed by GET /api/ask/history.
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    askApi
      .history(undefined, 50)
      .then(async (res) => {
        if (cancelled) return;
        // Lazy-load to keep this layout chunk small — the step store pulls
        // in the reducer + AG-UI schema, which the dock would download
        // anyway but we don't need on /auth or pre-login renders.
        const { hydrateFromHistory } = await import("@/lib/agent-events/store");
        if (cancelled) return;
        hydrateFromHistory(res.items);
      })
      .catch((err) => {
        // History is best-effort: an empty timeline is still usable, and the
        // dock will start fresh. Log so we notice in dev.
        console.warn("[ask] history fetch failed:", err);
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
    // URL is authoritative. If the visited path doesn't match `nav`, bring
    // the store in line with the URL — NOT the other way. Earlier the
    // store overrode the URL, which meant a direct visit to /app/today
    // bounced back to /app/chat for any user whose store still held its
    // default `nav: "chat"`.
    const pathToNav: Record<string, "chat" | "today" | "apps" | "settings"> = {
      "/app/chat": "chat",
      "/app/today": "today",
      "/app/applications": "apps",
      "/app/settings": "settings",
    };
    const desiredNav = pathToNav[current];
    if (desiredNav && desiredNav !== nav) {
      useVantage.getState().setNav(desiredNav);
    }
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
        // Populate the store's `resumes` array so the sidebar chip + dock
        // picker have data immediately. resumeWorkspace() above only sets
        // `currentResumeId`; this fills in the *list*. Fire-and-forget —
        // the loader swallows its own errors.
        void loadResumes();
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
  }, [router, resumeWorkspace, loadResumes]);

  if (!ready) {
    return <BrandLoader label="Preparing your workspace…" />;
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
        {/* Key the scroll container on the route so its content plays the
            `view-enter` rise on every navigation. The animation ends on
            identity, so sticky headers inside a view settle normally once it's
            done — see globals.css §Continuity layer (v7). */}
        <main key={pathname} className="view-enter flex-1 min-w-0 overflow-y-auto">{children}</main>
        <AskVantageDock />
      </div>
      <OnboardingTour />
      {prepId !== null && <PrepModal />}
    </div>
  );
}
