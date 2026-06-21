"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

// Vantage button primitive — single source of truth for the brown/cream/amber palette,
// focus-visible rings (WCAG-correct, not the 30%-opacity ring used in legacy auth/page.tsx),
// and three predictable sizes. Existing inline buttons across the workspace should migrate here.
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

const BASE =
  "relative inline-flex items-center justify-center gap-[8px] font-body font-semibold whitespace-nowrap cursor-pointer " +
  "transition-[transform,background-color,border-color,box-shadow,color] duration-200 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] " +
  "motion-safe:hover:-translate-y-[2px] active:translate-y-0 active:scale-[0.97] " +
  "outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 disabled:shadow-none";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "shine text-paper border-none bg-[linear-gradient(135deg,#7A3F00_0%,#5D3000_100%)] " +
    "shadow-[0_1px_2px_rgba(61,42,20,0.25),inset_0_1px_0_rgba(255,255,255,0.10)] " +
    "hover:shadow-[0_10px_24px_-8px_rgba(61,42,20,0.6),inset_0_1px_0_rgba(255,255,255,0.16)]",
  secondary:
    "bg-white text-ink border border-border-dark hover:border-brown hover:shadow-[0_6px_16px_-7px_rgba(61,42,20,0.28)]",
  ghost: "bg-transparent text-ink-light border-none hover:text-ink hover:bg-cream/60",
  danger:
    "bg-white text-ink border border-border-dark hover:border-amber hover:text-amber hover:shadow-[0_6px_16px_-7px_rgba(166,106,0,0.3)]",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "text-[13px] px-[14px] py-[8px] rounded-[9px]",
  md: "text-[14px] px-[18px] py-[10px] rounded-[10px]",
  lg: "text-[16px] px-[22px] py-[12px] rounded-[11px]",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "primary",
    size = "md",
    leadingIcon,
    trailingIcon,
    fullWidth,
    className,
    children,
    type,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        BASE,
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});
