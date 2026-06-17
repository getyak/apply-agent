"use client";

import { useEffect } from "react";
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
} from "lucide-react";
import { useVantage } from "@/lib/store";
import { initialsOf } from "@/lib/dates";
import { statusVisual } from "@/lib/status";

type NavId = "chat" | "today" | "apps" | "interviews" | "builder" | "mock" | "settings";

const ROUTES: Record<NavId, string> = {
  chat: "/app/chat",
  today: "/app/today",
  apps: "/app/applications",
  interviews: "/app/applications",
  builder: "/app/studio/resume",
  mock: "/app/studio/mock",
  settings: "/app/settings",
};

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

  useEffect(() => {
    if (!currentUser) loadCurrentUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Counts driven by the real applications list, so the badge stops drifting
  // away from what the user sees on the kanban board.
  const interviewingCount = apiApplications.filter(
    (a) => statusVisual(a.status).column === "interviewing",
  ).length;

  const active = (id: NavId): boolean => {
    if (id === "interviews") return false;
    if (id === "chat") return pathname === "/app/chat";
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
    if (id === "chat") setNav("chat");
    if (id === "today") setNav("today");
    if (id === "apps" || id === "interviews") setNav("apps");
    if (id === "settings") setNav("settings");
    router.push(ROUTES[id]);
    if (id === "interviews") setTimeout(() => openPrep(0), 60);
  };

  const navItem = (isActive: boolean) =>
    `flex items-center gap-[10px] px-[10px] py-[9px] rounded-[9px] cursor-pointer text-[14px] font-medium transition-colors ${
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
    <aside className="w-[248px] shrink-0 bg-white border-r border-border flex flex-col py-[22px] px-4">
      <div className="flex items-center gap-[9px] px-[10px] pb-[26px]">
        <div className="w-6 h-6 rounded-[6px] bg-brown flex items-center justify-center">
          <Check className="w-[14px] h-[14px] text-paper" strokeWidth={2.2} />
        </div>
        <span className="font-display font-bold text-[15px] tracking-[2.5px] text-brown">
          VANTAGE
        </span>
      </div>

      <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted px-[10px] pb-2">
        Workspace
      </div>
      <nav className="flex flex-col gap-[2px]">
        <div data-tour="ask" className={navItem(active("chat"))} onClick={() => go("chat")}>
          <MessageSquare className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Ask Vantage</span>
        </div>
        <div data-tour="today" className={navItem(active("today"))} onClick={() => go("today")}>
          <Home className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Today</span>
        </div>
        <div data-tour="apps" className={navItem(active("apps"))} onClick={() => go("apps")}>
          <LayoutGrid className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Applications</span>
          <span className="ml-auto font-mono text-[10px] font-medium bg-[#F3F0EB] text-ink-light px-[7px] py-[2px] rounded-full">
            {totalApps}
          </span>
        </div>
        <div className={navItem(false)} onClick={() => go("interviews")}>
          <Calendar className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Interviews</span>
          {interviewingCount > 0 && (
            <span className="ml-auto font-mono text-[10px] font-medium bg-gold-bg text-amber px-[7px] py-[2px] rounded-full">
              {interviewingCount}
            </span>
          )}
        </div>
      </nav>

      <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted px-[10px] pt-6 pb-2 flex items-center gap-[7px]">
        <Sparkles className="w-3 h-3 text-amber" strokeWidth={1.8} />
        AI Studio
      </div>
      <nav className="flex flex-col gap-[2px]">
        <div className={navItem(active("builder"))} onClick={() => go("builder")}>
          <FileText className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Résumé studio</span>
        </div>
        <div className={navItem(active("mock"))} onClick={() => go("mock")}>
          <MessageSquare className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Mock interview</span>
        </div>
      </nav>

      <div className="mt-auto" />

      <nav className="flex flex-col gap-[2px] mb-3">
        <div className={navItem(active("settings"))} onClick={() => go("settings")}>
          <Settings className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Settings</span>
        </div>
      </nav>

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

      <div className="flex items-center gap-[10px] px-2 py-[6px]">
        <div
          className="w-[34px] h-[34px] rounded-[9px] bg-brown flex items-center justify-center font-display font-bold text-[14px] text-paper shrink-0"
          aria-hidden="true"
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-body font-semibold text-[13px] text-ink truncate">
            {displayName}
          </div>
          {subline ? (
            <div className="font-body text-[11px] text-ink-muted truncate">{subline}</div>
          ) : null}
        </div>
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
