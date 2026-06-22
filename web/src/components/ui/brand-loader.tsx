import type { CSSProperties } from "react";

/**
 * BrandLoader — the one full-screen "we're getting ready" shell used by the
 * auth Suspense fallback, the session-verify guard, and the workspace boot
 * gate. Previously each of those rendered a bespoke wordmark + a pulsing line
 * of mono text, which read flat against the warm palette. This unifies them
 * into a single crafted moment: a lit-gold wordmark that rises in, a soft
 * aurora glow behind it, and three gold dots that bob in sequence.
 *
 * Everything here is pure CSS and collapses under `prefers-reduced-motion`
 * via the global guard, so motion-sensitive users get a calm static screen.
 */
export default function BrandLoader({ label }: { label?: string }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-paper flex items-center justify-center px-4">
      {/* Warm light pooling behind the wordmark — purely decorative. */}
      <div
        aria-hidden
        className="aurora-blob -z-10 w-[340px] h-[340px] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-40"
      />
      <div className="relative flex flex-col items-center gap-4 animate-fade-up">
        <div className="font-display text-[18px] font-bold tracking-[3px]">
          <span className="gradient-text text-halo crown">VANTAGE</span>
        </div>
        <div className="flex items-center gap-[6px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="loader-dot"
              style={{ animationDelay: `${i * 0.16}s` } as CSSProperties}
            />
          ))}
        </div>
        {label && (
          <p className="font-mono text-[12px] tracking-[0.5px] uppercase text-ink-muted">
            {label}
          </p>
        )}
      </div>
    </div>
  );
}
