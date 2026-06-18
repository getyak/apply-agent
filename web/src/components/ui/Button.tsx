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
  "inline-flex items-center justify-center gap-[8px] font-body font-semibold whitespace-nowrap cursor-pointer transition-colors " +
  "outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brown text-paper border-none hover:bg-brown-light",
  secondary: "bg-white text-ink border border-border-dark hover:border-brown",
  ghost: "bg-transparent text-ink-light border-none hover:text-ink",
  danger: "bg-white text-ink border border-border-dark hover:border-amber hover:text-amber",
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
