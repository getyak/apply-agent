"use client";

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

export function ScoreRing({ value, size = 72, label, className }: ScoreRingProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const stroke = 6;
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const dash = c.toFixed(2);
  const offset = (c - (c * clamped) / 100).toFixed(2);
  const color =
    clamped >= 85 ? "#4C7A3F" : clamped >= 70 ? "#A66A00" : "#A39F99";
  const textColor =
    clamped >= 85 ? "text-green" : clamped >= 70 ? "text-amber" : "text-ink-muted";

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? `Match score: ${clamped}%`}
    >
      <svg width={size} height={size} className="-rotate-90">
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
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={dash}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      <div className={cn("absolute inset-0 flex items-center justify-center font-display font-bold text-[20px]", textColor)}>
        {clamped}
      </div>
    </div>
  );
}
