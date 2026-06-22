"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
import { useDock } from "@/lib/ask-vantage-store";
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
  // `userCollapsed` is the user's *saved* preference (the toggle button
  // reads and writes this). `collapsed` is the effective render state —
  // see N3 below for why the two diverge during Mock live.
  const [userCollapsed, setUserCollapsed] = useState(false);
  // N3 (round-2): mirror the dock's `hintedCollapse` signal — when a Mock
  // live session asks for an immersive stage (vantage-ui-mapping.md §3.6
  // promises *both* dock → launcher *and* sidebar → 74px rail), the
  // sidebar collapses too. Before round-2 only the dock listened, so the
  // left rail stayed at 248px and the immersive promise was half-broken.
  // We deliberately *don't* persist this to localStorage — it's an
  // ephemeral overlay-state override, not the user's preference. When the
  // mock screen unmounts, layout.tsx clears `hintedCollapse` and the
  // effective `collapsed` boolean below resolves back to the user's saved
  // value automatically.
  const hintedCollapse = useDock((s) => s.hintedCollapse);
  const collapsed = userCollapsed || hintedCollapse;

  useEffect(() => {
    if (!currentUser) loadCurrentUser();
    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      // Hydrating client preference from localStorage on mount is the
      // canonical "sync external system → state" effect; the cascading-render
      // lint is a false positive here because this only fires once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw === "1") setUserCollapsed(true);
      // Mobile fallback: under ~lg the 3-column desktop layout becomes
      // unusable (sidebar + main + dock fight for 390px of width — QA bug
      // #8). Force the sidebar into icon-only mode at narrow widths and
      // re-evaluate on resize. The user's saved preference still wins on
      // desktop because that branch runs first.
      const mql = window.matchMedia("(max-width: 1023px)");
      const apply = () => {
        if (mql.matches) setUserCollapsed(true);
      };
      apply();
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCollapsed = () => {
    setUserCollapsed((v) => {
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

  // Active state is derived purely from `pathname` — the single source of
  // truth. Earlier we mixed nav-store state with router intent, so a click
  // could highlight "Today" while the page below still showed Chat because
  // the URL hadn't caught up yet (QA bug #3 — URL ↔ content mismatch).
  const active = (id: NavId): boolean => {
    if (id === "interviews") return false;
    if (id === "today") return pathname === "/app/today";
    if (id === "apps") return pathname === "/app/applications";
    if (id === "builder") return pathname === "/app/studio/resume" || pathname === "/app/resume";
    if (id === "mock") return pathname === "/app/studio/mock";
    if (id === "settings") return pathname === "/app/settings";
    return false;
  };

  // Side-effect helper kept for the Interviews nav item, which still has to
  // open the prep modal in addition to navigating. Normal nav items use a
  // <Link> and never call this — that's how we keep the URL authoritative.
  const onNavClick = (id: NavId) => {
    setScreen("app");
    if (id === "today") setNav("today");
    if (id === "apps" || id === "interviews") setNav("apps");
    if (id === "settings") setNav("settings");
    if (id === "interviews") setTimeout(() => openPrep(0), 60);
  };

  const navItem = (isActive: boolean) =>
    `nav-rail press flex items-center gap-[10px] ${
      collapsed ? "justify-center px-0" : "px-[10px]"
    } py-[9px] rounded-[9px] cursor-pointer text-[14px] font-medium transition-[background-color,color,box-shadow] duration-200 ${
      isActive
        ? "nav-chip text-brown font-semibold"
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
      className={`width-ease ${
        collapsed ? "w-[74px] px-2" : "w-[248px] px-4"
      } shrink-0 bg-white border-r border-border flex flex-col py-[22px]`}
    >
      {/* Brand mark — also the "home" affordance. Clicking it routes to
          /app/today (the highest-signal landing screen — see app/page.tsx)
          and resets nav + screen state so any open overlay (review /
          extension / builder / mock / onboarding) is dismissed. Behaves
          like a sidebar nav item in both expanded and collapsed modes.
          Real <Link> so middle-click / cmd-click open in a new tab. */}
      <Link
        href="/app/today"
        onClick={() => onNavClick("today")}
        title={collapsed ? "Vantage — back to Today" : "Back to Today"}
        aria-label="Vantage — back to Today"
        className={`flex items-center ${
          collapsed ? "justify-center" : "gap-[9px] px-[10px]"
        } pb-[20px] cursor-pointer bg-transparent border-0 text-left hover:opacity-80 transition-opacity`}
      >
        <div className="sheen-host press w-6 h-6 rounded-[6px] bg-[linear-gradient(135deg,#7A3F00_0%,#5D3000_100%)] flex items-center justify-center shrink-0 shadow-[0_1px_2px_rgba(61,42,20,0.25),inset_0_1px_0_rgba(255,255,255,0.12)]">
          <Check className="w-[14px] h-[14px] text-paper" strokeWidth={2.2} />
          <span className="sheen" />
        </div>
        {!collapsed && (
          <span className="font-display font-bold text-[15px] tracking-[2.5px] text-brown">
            VANTAGE
          </span>
        )}
      </Link>

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
      <nav className="flex flex-col gap-[2px]" aria-label="Workspace">
        <Link
          href={ROUTES.today}
          data-tour="today"
          className={navItem(active("today"))}
          onClick={() => onNavClick("today")}
          title={collapsed ? "Today" : undefined}
          aria-current={active("today") ? "page" : undefined}
          data-active={active("today") ? "true" : undefined}
        >
          <Home data-nav-icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} aria-hidden="true" />
          {!collapsed && <span>Today</span>}
        </Link>
        <Link
          href={ROUTES.apps}
          data-tour="apps"
          className={navItem(active("apps"))}
          onClick={() => onNavClick("apps")}
          title={collapsed ? "Applications" : undefined}
          aria-current={active("apps") ? "page" : undefined}
          data-active={active("apps") ? "true" : undefined}
        >
          <LayoutGrid data-nav-icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} aria-hidden="true" />
          {!collapsed && (
            <>
              <span>Applications</span>
              <span key={totalApps} className="count-pop count-tick ml-auto font-mono text-[10px] font-medium bg-[#F3F0EB] text-ink-light px-[7px] py-[2px] rounded-full">
                {totalApps}
              </span>
            </>
          )}
        </Link>
        <Link
          href={ROUTES.interviews}
          className={navItem(false)}
          onClick={() => onNavClick("interviews")}
          title={collapsed ? "Interviews" : undefined}
        >
          <Calendar data-nav-icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} aria-hidden="true" />
          {!collapsed && (
            <>
              <span>Interviews</span>
              {interviewingCount > 0 && (
                <span key={interviewingCount} className="count-pop count-tick ml-auto font-mono text-[10px] font-medium bg-gold-bg text-amber px-[7px] py-[2px] rounded-full">
                  {interviewingCount}
                </span>
              )}
            </>
          )}
        </Link>
      </nav>

      {!collapsed ? (
        <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted px-[10px] pt-6 pb-2 flex items-center gap-[7px]">
          <Sparkles className="w-3 h-3 text-amber" strokeWidth={1.8} />
          AI Studio
        </div>
      ) : (
        <div className="h-[10px]" />
      )}
      <nav className="flex flex-col gap-[2px]" aria-label="AI studio">
        <Link
          href={ROUTES.builder}
          className={navItem(active("builder"))}
          onClick={() => onNavClick("builder")}
          title={collapsed ? "Résumé studio" : undefined}
          aria-current={active("builder") ? "page" : undefined}
          data-active={active("builder") ? "true" : undefined}
        >
          <FileText data-nav-icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} aria-hidden="true" />
          {!collapsed && <span>Résumé studio</span>}
        </Link>
        <Link
          href={ROUTES.mock}
          className={navItem(active("mock"))}
          onClick={() => onNavClick("mock")}
          title={collapsed ? "Mock interview" : undefined}
          aria-current={active("mock") ? "page" : undefined}
          data-active={active("mock") ? "true" : undefined}
        >
          <MessageSquare data-nav-icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} aria-hidden="true" />
          {!collapsed && <span>Mock interview</span>}
        </Link>
      </nav>

      <div className="mt-auto" />

      <nav className="flex flex-col gap-[2px] mb-3" aria-label="Account">
        <Link
          href={ROUTES.settings}
          className={navItem(active("settings"))}
          onClick={() => onNavClick("settings")}
          title={collapsed ? "Settings" : undefined}
          aria-current={active("settings") ? "page" : undefined}
          data-active={active("settings") ? "true" : undefined}
        >
          <Settings data-nav-icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.7} aria-hidden="true" />
          {!collapsed && <span>Settings</span>}
        </Link>
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
          <div className="bar-track h-[6px] rounded-full bg-border overflow-hidden">
            <div
              className="bar-fill h-full rounded-full bg-[linear-gradient(90deg,#7A3F00,#A66A00)]"
              style={{ width: "35%" }}
            />
          </div>
          <div className="font-body text-[11px] text-ink-muted mt-[9px]">
            Resets in 14 days ·{" "}
            <span className="link-pull text-brown font-semibold cursor-pointer">Upgrade</span>
          </div>
        </div>
      )}

      <div
        className={`flex items-center ${
          collapsed ? "flex-col gap-[8px] py-2" : "gap-[10px] px-2 py-[6px]"
        }`}
      >
        <div
          className="avatar-ring w-[34px] h-[34px] rounded-[9px] bg-brown flex items-center justify-center font-display font-bold text-[14px] text-paper shrink-0"
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
