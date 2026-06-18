"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";

// Cream/AI hint container used by coach feedback in mock-interview, review cover note, prep-modal.
// One primitive so the AI-content visual signal stays consistent.
interface HintBoxProps {
  label?: string;
  tone?: "ai" | "info" | "success";
  children: ReactNode;
  className?: string;
}

const TONE = {
  ai: { box: "bg-gold-bg border-cream-border", label: "text-amber" },
  info: { box: "bg-cream border-cream-border", label: "text-brown" },
  success: { box: "bg-green-bg border-green-bg", label: "text-green" },
} as const;

export function HintBox({ label, tone = "info", children, className }: HintBoxProps) {
  const t = TONE[tone];
  return (
    <div className={cn("border rounded-[11px] px-4 py-3", t.box, className)}>
      {label && (
        <div className={cn("font-mono text-[9px] tracking-[0.6px] uppercase mb-[5px]", t.label)}>
          {label}
        </div>
      )}
      <div className="font-body text-[13px] leading-[1.55] text-ink">
        {children}
      </div>
    </div>
  );
}
