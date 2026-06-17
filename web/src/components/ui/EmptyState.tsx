"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";

// Cream-tone placeholder card for "no data yet" surfaces (mock-interview without a real session,
// review with no current job, tracker empty columns, etc.). Centralises a copy/visual pattern
// that was previously inlined inconsistently.
interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "bg-cream border border-cream-border rounded-[14px] p-[22px] flex flex-col items-center text-center gap-3",
        className,
      )}
    >
      {icon && <div className="text-brown">{icon}</div>}
      <div className="font-display font-bold text-[15px] text-ink">{title}</div>
      {description && (
        <div className="font-body text-[13.5px] leading-[1.55] text-ink-light max-w-[360px]">
          {description}
        </div>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
