"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "./cn";

// Circular match-score ring used in review.tsx & today-view.tsx today as ad-hoc SVG.
// Auto-picks the right color based on score: green ≥ 85, amber 70–84, ink-muted < 70.
// Provides aria-label so screen readers announce "Match score: NN%" instead of dead SVG.
interface ScoreRingProps {
  value: number;
  size?: number;
  label?: string;
  className?: string;
}

// Animate a number from 0 → target on mount with an ease-out curve, so the
// ring "fills" and the digits count up. Honours prefers-reduced-motion by
// snapping straight to the final value.
function useCountUp(target: number, duration = 950) {
  const [value, setValue] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    // Reduced-motion users get duration 0 → the first rAF tick snaps to the
    // target. Keeping it inside the rAF callback (never synchronous in the
    // effect body) avoids cascading-render warnings.
    const reduce =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const span = reduce ? 0 : duration;
    const start = performance.now();
    const tick = (now: number) => {
      const t = span <= 0 ? 1 : Math.min(1, (now - start) / span);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setValue(Math.round(target * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, duration]);
  return value;
}

export function ScoreRing({ value, size = 72, label, className }: ScoreRingProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const display = useCountUp(clamped);
  const stroke = 6;
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const dash = c.toFixed(2);
  // Drive the arc from the animated `display` value so stroke + digits move together.
  const offset = (c - (c * display) / 100).toFixed(2);
  const color =
    clamped >= 85 ? "#4C7A3F" : clamped >= 70 ? "#A66A00" : "#A39F99";
  // Two-stop gradient (lighter tint → base) gives the arc volume rather than a
  // flat band of colour.
  const colorLight =
    clamped >= 85 ? "#76A85F" : clamped >= 70 ? "#D69A2A" : "#C2BCB2";
  const textColor =
    clamped >= 85 ? "text-green" : clamped >= 70 ? "text-amber" : "text-ink-muted";
  const gid = `ring-grad-${useId().replace(/[:]/g, "")}`;

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? `Match score: ${clamped}%`}
    >
      <svg width={size} height={size} className="-rotate-90 overflow-visible">
        <defs>
          <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={colorLight} />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#E8DCCA"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={dash}
          strokeDashoffset={offset}
          style={{
            filter: `drop-shadow(0 0 6px ${color}40)`,
            transition: "stroke-dashoffset 0.2s linear",
          }}
        />
      </svg>
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center font-display font-bold text-[20px] tabular-nums",
          textColor,
        )}
      >
        {display}
      </div>
    </div>
  );
}
