"use client";

import {
  forwardRef,
  useCallback,
  useRef,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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
  "group/btn relative inline-flex items-center justify-center gap-[8px] font-body font-semibold whitespace-nowrap cursor-pointer " +
  "transition-[transform,background-color,border-color,box-shadow,color] duration-200 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] " +
  "motion-safe:hover:-translate-y-[2px] active:translate-y-0 active:scale-[0.97] " +
  "outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 disabled:shadow-none";

const ICON =
  "inline-flex shrink-0 transition-transform duration-200 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "shine text-paper border-none bg-[linear-gradient(135deg,#7A3F00_0%,#5D3000_100%)] " +
    "shadow-[0_1px_2px_rgba(61,42,20,0.25),inset_0_1px_0_rgba(255,255,255,0.10)] " +
    "hover:shadow-[0_12px_28px_-8px_rgba(61,42,20,0.62),0_0_0_1px_rgba(232,163,23,0.20),inset_0_1px_0_rgba(255,255,255,0.18)]",
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
    onPointerDown,
    ...rest
  },
  ref,
) {
  // Ripple layer — a warm bloom radiates from the exact contact point on press,
  // so a click reads as a physical impact. The ripple lives in a dedicated
  // clipped layer (not the button itself) so the focus-visible ring is never
  // clipped. Honours prefers-reduced-motion and skips when disabled.
  const rippleHost = useRef<HTMLSpanElement>(null);
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(e);
      if (e.defaultPrevented || rest.disabled) return;
      if (
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const host = rippleHost.current;
      if (!host) return;
      const r = host.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2.1;
      const dot = document.createElement("span");
      dot.className = "ripple";
      dot.style.setProperty("--rx", `${e.clientX - r.left}px`);
      dot.style.setProperty("--ry", `${e.clientY - r.top}px`);
      dot.style.setProperty("--rs", `${size}px`);
      dot.addEventListener("animationend", () => dot.remove(), { once: true });
      host.appendChild(dot);
    },
    [onPointerDown, rest.disabled],
  );

  return (
    <button
      ref={ref}
      type={type ?? "button"}
      onPointerDown={handlePointerDown}
      className={cn(
        BASE,
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      <span ref={rippleHost} aria-hidden className="ripple-layer" />
      {leadingIcon && (
        <span className={cn(ICON, "motion-safe:group-hover/btn:-translate-x-[1px]")}>
          {leadingIcon}
        </span>
      )}
      {children}
      {trailingIcon && (
        <span className={cn(ICON, "motion-safe:group-hover/btn:translate-x-[2px]")}>
          {trailingIcon}
        </span>
      )}
    </button>
  );
});
