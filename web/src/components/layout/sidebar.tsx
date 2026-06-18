"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  MessageSquare,
  Home,
  LayoutGrid,
  Calendar,
  FileText,
  Sparkles,
  Check,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useVantage } from "@/lib/store";
import { initialsOf } from "@/lib/dates";
import { statusVisual } from "@/lib/status";

// Ask Vantage is intentionally NOT in this nav anymore — the persistent dock
// (mounted by AppLayout) is its sole surface, per vantage-ui-mapping.md §1.
type NavId = "today" | "apps" | "interviews" | "builder" | "mock" | "settings";

const ROUTES: Record<NavId, string> = {
  today: "/app/today",
  apps: "/app/applications",
  interviews: "/app/applications",
  builder: "/app/studio/resume",
  mock: "/app/studio/mock",
  settings: "/app/settings",
};

const COLLAPSED_KEY = "vantage.sidebar.collapsed";

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const apiApplications = useVantage((s) => s.apiApplications ?? []);
  const setNav = useVantage((s) => s.setNav);
  const openPrep = useVantage((s) => s.openPrep);
  const setScreen = useVantage((s) => s.setScreen);
  const currentUser = useVantage((s) => s.currentUser);
  const parsedResume = useVantage((s) => s.parsedResume);
  const loadCurrentUser = useVantage((s) => s.loadCurrentUser);
  const signOut = useVantage((s) => s.signOut);

  // Collapsed = 74px icon-only rail. Width persisted to localStorage so the
  // user's preference survives reloads. Default to expanded so first-time
  // users see the full nav vocabulary.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!currentUser) loadCurrentUser();
    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      // Hydrating client preference from localStorage on mount is the
      // canonical "sync external system → state" effect; the cascading-render
      // lint is a false positive here because this only fires once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw === "1") setCollapsed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      if (typeof window !== "undefined")
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  };

  // Counts driven by the real applications list, so the badge stops drifting
  // away from what the user sees on the kanban board.
  const interviewingCount = apiApplications.filter(
    (a) => statusVisual(a.status).column === "interviewing",
  ).length;

  const active = (id: NavId): boolean => {
    if (id === "interviews") return false;
    if (id === "today") return pathname === "/app/today";
    if (id === "apps") return pathname === "/app/applications";
    if (id === "builder") return pathname === "/app/studio/resume";
    if (id === "mock") return pathname === "/app/studio/mock";
    if (id === "settings") return pathname === "/app/settings";
    return false;
  };

  // Keep store-state at screen="app" so overlay screens (review/extension/
  // builder/mock) stay free to take over via screen=...; tab clicks also push
  // the URL so refresh and back/forward both work as expected.
  const go = (id: NavId) => {
    setScreen("app");
    if (id === "today") setNav("today");
    if (id === "apps" || id === "interviews") setNav("apps");
    if (id === "settings") setNav("settings");
    router.push(ROUTES[id]);
    if (id === "interviews") setTimeout(() => openPrep(0), 60);
  };

  const navItem = (isActive: boolean) =>
    `flex items-center gap-[10px] ${
      collapsed ? "justify-center px-0" : "px-[10px]"
    } py-[9px] rounded-[9px] cursor-pointer text-[14px] font-medium transition-colors ${
      isActive
        ? "bg-cream text-brown font-semibold"
        : "text-ink-light hover:bg-[#F8F5F0] hover:text-ink"
    }`;

  const totalApps = apiApplications.length;

  // Display name precedence: the parsed JSON Resume basics.name (what the
  // user actually wrote in their CV) → auth display_name → "Welcome". We
  // never fall back to the historical "Jordan Avery" placeholder.
  const displayName =
    (parsedResume?.basics?.name?.trim() || "") ||
    (currentUser?.displayName?.trim() || "") ||
    "Welcome";
  const initials = initialsOf(displayName);
  const subline =
    parsedResume?.basics?.label?.trim() ||
    currentUser?.email ||
    "";

  const handleSignOut = () => {
    signOut();
    router.push("/");
  };

  return (
    <aside
      className={`${
        collapsed ? "w-[74px] px-2" : "w-[248px] px-4"
      } shrink-0 bg-white border-r border-border flex flex-col py-[22px] transition-[width] duration-150`}
    >
      <div
        className={`flex items-center ${
          collapsed ? "justify-center" : "gap-[9px] px-[10px]"
        } pb-[20px]`}
      >
        <div className="w-6 h-6 rounded-[6px] bg-brown flex items-center justify-center shrink-0">
          <Check className="w-[14px] h-[14px] text-paper" strokeWidth={2.2} />
        </div>
        {!collapsed && (
          <span className="font-display font-bold text-[15px] tracking-[2.5px] text-brown">
            VANTAGE
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={toggleCollapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={`flex items-center ${
          collapsed ? "justify-center" : "justify-end px-[10px]"
        } py-[6px] mb-2 text-ink-muted hover:text-brown transition-colors cursor-pointer`}
      >
        {collapsed ? (
          <PanelLeftOpen className="w-[16px] h-[16px]" strokeWidth={1.7} />
        ) : (
          <PanelLeftClose className="w-[16px] h-[16px]" strokeWidth={1.7} />
        )}
      </button>

      {!collapsed && (
        <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted px-[10px] pb-2">
          Workspace
        </div>
      )}
      <nav className="flex flex-col gap-[2px]">
        <div
          data-tour="today"
          className={navItem(active("today"))}
          onClick={() => go("today")}
          title={collapsed ? "Today" : undefined}
        >
          <Home className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} />
          {!collapsed && <span>Today</span>}
        </div>
        <div
          data-tour="apps"
          className={navItem(active("apps"))}
          onClick={() => go("apps")}
          title={collapsed ? "Applications" : undefined}
        >
          <LayoutGrid className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} />
          {!collapsed && (
            <>
              <span>Applications</span>
              <span className="ml-auto font-mono text-[10px] font-medium bg-[#F3F0EB] text-ink-light px-[7px] py-[2px] rounded-full">
                {totalApps}
              </span>
            </>
          )}
        </div>
        <div
          className={navItem(false)}
          onClick={() => go("interviews")}
          title={collapsed ? "Interviews" : undefined}
        >
          <Calendar className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} />
          {!collapsed && (
            <>
              <span>Interviews</span>
              {interviewingCount > 0 && (
                <span className="ml-auto font-mono text-[10px] font-medium bg-gold-bg text-amber px-[7px] py-[2px] rounded-full">
                  {interviewingCount}
                </span>
              )}
            </>
          )}
        </div>
      </nav>

      {!collapsed ? (
        <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted px-[10px] pt-6 pb-2 flex items-center gap-[7px]">
          <Sparkles className="w-3 h-3 text-amber" strokeWidth={1.8} />
          AI Studio
        </div>
      ) : (
        <div className="h-[10px]" />
      )}
      <nav className="flex flex-col gap-[2px]">
        <div
          className={navItem(active("builder"))}
          onClick={() => go("builder")}
          title={collapsed ? "Résumé studio" : undefined}
        >
          <FileText className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} />
          {!collapsed && <span>Résumé studio</span>}
        </div>
        <div
          className={navItem(active("mock"))}
          onClick={() => go("mock")}
          title={collapsed ? "Mock interview" : undefined}
        >
          <MessageSquare className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} />
          {!collapsed && <span>Mock interview</span>}
        </div>
      </nav>

      <div className="mt-auto" />

      <nav className="flex flex-col gap-[2px] mb-3">
        <div
          className={navItem(active("settings"))}
          onClick={() => go("settings")}
          title={collapsed ? "Settings" : undefined}
        >
          <Settings className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} />
          {!collapsed && <span>Settings</span>}
        </div>
      </nav>

      {!collapsed && (
        <div className="bg-[#FBF8F3] border border-border rounded-xl p-[14px] mb-3">
          <div className="flex items-center justify-between mb-[9px]">
            <span className="font-mono text-[10px] tracking-[0.6px] uppercase text-ink-light">
              Auto-applies
            </span>
            <span className="font-mono text-[10px] tracking-[0.6px] text-brown">
              14 / 40
            </span>
          </div>
          <div className="h-[6px] rounded-full bg-border overflow-hidden">
            <div className="h-full rounded-full bg-brown" style={{ width: "35%" }} />
          </div>
          <div className="font-body text-[11px] text-ink-muted mt-[9px]">
            Resets in 14 days ·{" "}
            <span className="text-brown font-semibold cursor-pointer">Upgrade</span>
          </div>
        </div>
      )}

      <div
        className={`flex items-center ${
          collapsed ? "flex-col gap-[8px] py-2" : "gap-[10px] px-2 py-[6px]"
        }`}
      >
        <div
          className="w-[34px] h-[34px] rounded-[9px] bg-brown flex items-center justify-center font-display font-bold text-[14px] text-paper shrink-0"
          aria-hidden="true"
          title={collapsed ? displayName : undefined}
        >
          {initials}
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="font-body font-semibold text-[13px] text-ink truncate">
              {displayName}
            </div>
            {subline ? (
              <div className="font-body text-[11px] text-ink-muted truncate">{subline}</div>
            ) : null}
          </div>
        )}
        {currentUser && (
          <button
            type="button"
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center text-ink-muted hover:text-brown hover:bg-cream transition-colors cursor-pointer"
          >
            <LogOut className="w-[15px] h-[15px]" strokeWidth={1.7} />
          </button>
        )}
      </div>
    </aside>
  );
}
