"use client";

import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "./cn";

// Vantage card primitive. Standardises the cream/white container shapes used across
// review/builder/mock-interview/today views so border-radius + border + shadow stay in lockstep.
type Tone = "paper" | "cream" | "ai";

interface CardProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  padding?: "sm" | "md" | "lg";
}

const TONE: Record<Tone, string> = {
  paper: "bg-white border border-border",
  cream: "bg-cream border border-cream-border",
  ai: "bg-gold-bg border border-cream-border",
};

const PAD = {
  sm: "p-4",
  md: "p-5",
  lg: "p-[22px]",
} as const;

export function Card({ children, tone = "paper", className, padding = "md" }: CardProps) {
  return (
    <div className={cn(TONE[tone], "rounded-[14px] shadow-sm", PAD[padding], className)}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  tag?: string;
  ai?: boolean;
}

export function CardHeader({ title, tag, ai }: CardHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-display font-bold text-[15px] text-ink">{title}</h3>
      {tag && (
        <span
          className={cn(
            "inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.4px] uppercase px-2 py-1 rounded-full shrink-0",
            ai ? "text-amber bg-gold-bg" : "text-ink-light bg-cream",
          )}
        >
          {ai && <Sparkles size={10} />}
          {ai ? `AI · ${tag}` : tag}
        </span>
      )}
    </div>
  );
}
