"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ChevronDown, ArrowRight, LogOut } from "lucide-react";
import { auth as authApi } from "@/lib/api";
import { useVantage } from "@/lib/store";
import { initialsOf } from "@/lib/dates";

// Signed-in account control for the marketing nav. The landing page is a
// server component and can only presence-check the token cookie — it can't
// know *who* the user is (name lives behind the API me() call). This client
// chip fills that gap: on mount it resolves the display name so the nav shows
// the user's avatar + name, making "I'm logged in" visible at a glance.
//
// Rendered only when the server already saw a token cookie, so there's no
// auth-state flicker — worst case the avatar shows a placeholder initial for
// the one round-trip it takes me() to resolve the name.
export function LandingAccountChip() {
  const t = useTranslations("landing.accountChip");
  const router = useRouter();
  const signOut = useVantage((s) => s.signOut);
  const [name, setName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Resolve the display name once. A 401 (expired token) leaves name null and
  // the avatar shows the placeholder; the chip still works as an
  // "Open workspace" entry, and the /app layout's me() guard handles the
  // expired token from there — same contract as a direct /app visit.
  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((res) => {
        if (!cancelled) setName(res.user.display_name || res.user.email || null);
      })
      .catch(() => {
        // Stay silent: chip degrades to the placeholder avatar, still usable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the menu on outside click / Escape so it behaves like a real menu.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSignOut = () => {
    signOut();
    setOpen(false);
    // Stay on the landing page, then refresh so the server component re-reads
    // the (now-cleared) cookie and renders the guest nav again.
    router.refresh();
  };

  const initials = initialsOf(name);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="press group flex items-center gap-2 rounded-[10px] border border-border-dark bg-white pl-1.5 pr-2.5 py-1.5 transition-[border-color,box-shadow] duration-200 hover:border-brown hover:shadow-[0_4px_12px_-6px_rgba(61,42,20,0.3)] cursor-pointer"
      >
        <span className="avatar-ring avatar-gleam w-[28px] h-[28px] rounded-[8px] bg-brown flex items-center justify-center font-display font-bold text-[12px] text-paper shrink-0">
          {initials}
        </span>
        <span className="hidden sm:block max-w-[140px] truncate font-body font-medium text-sm text-ink">
          {name ?? t("fallbackName")}
        </span>
        <ChevronDown
          size={15}
          strokeWidth={2}
          className={`text-ink-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="menu-pop menu-stagger absolute right-0 top-[calc(100%+8px)] z-50 w-[212px] origin-top-right overflow-hidden rounded-[12px] border border-border bg-paper p-1.5 shadow-[0_18px_40px_-12px_rgba(61,42,20,0.32)]"
        >
          {/* Warm gold seam across the menu's lip — the v10 "lit chrome" cue,
              tying the popover to the nav seam below the scrolled header. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-gold/55 to-transparent"
          />
          <a
            href="/app"
            role="menuitem"
            style={{ "--i": 0 } as CSSProperties}
            className="group/item flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 no-underline transition-colors hover:bg-cream"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-brown text-paper">
              <ArrowRight size={14} strokeWidth={2} />
            </span>
            <span className="font-body text-sm font-medium text-ink">{t("openWorkspace")}</span>
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            style={{ "--i": 1 } as CSSProperties}
            className="group/item flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 transition-colors hover:bg-cream cursor-pointer"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-border text-ink-muted group-hover/item:text-brown">
              <LogOut size={14} strokeWidth={1.8} />
            </span>
            <span className="font-body text-sm font-medium text-ink-light group-hover/item:text-ink">
              {t("signOut")}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
