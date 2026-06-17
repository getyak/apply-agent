"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";

// Inline label/tag, used for matched-skills, missing-skills, AI source markers.
// Uses font-mono on purpose — it's the Vantage convention for "metadata over content".
type BadgeTone = "neutral" | "matched" | "gap" | "ai" | "info";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-cream text-ink-light",
  matched: "bg-green-bg text-green",
  gap: "bg-gold-bg text-amber",
  ai: "bg-gold-bg text-amber",
  info: "bg-cream text-brown",
};

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.4px] uppercase px-2 py-1 rounded",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
