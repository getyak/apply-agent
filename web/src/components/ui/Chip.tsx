"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

// Suggestion chips (mock-interview "Suggested angle", builder choice chips).
// Active state pulls the Vantage brown for confirmed selection.
interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function Chip({ active, className, children, type, ...rest }: ChipProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "cursor-pointer font-body font-medium text-[13px] px-[15px] py-[9px] rounded-full max-w-[320px] text-left transition-all",
        "outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
        active
          ? "bg-brown text-paper border-none"
          : "bg-white border border-border-dark text-ink hover:border-brown hover:bg-cream",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
