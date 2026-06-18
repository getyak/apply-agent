"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useVantage } from "@/lib/store";

// Lightweight onboarding tour: a 3-step spotlight + popover. The first step
// anchors to the Ask Vantage dock (right rail / launcher pill), the next two
// anchor to the Today / Applications sidebar tabs. No external library; pure
// React + the existing Tailwind tokens. Anchors are looked up by data-tour
// id, which the dock and Sidebar set on the relevant DOM nodes.

const STEPS: { target: string; title: string; body: string }[] = [
  {
    target: "dock",
    title: "Ask Vantage anything",
    body: "The dock on the right is always here — find roles, tailor a résumé, prep an interview. Send a chip to fire it instantly, or write your own.",
  },
  {
    target: "today",
    title: "Today's matches",
    body: "Fresh roles scored against your résumé, with the strongest fit at the top. We refresh this every morning.",
  },
  {
    target: "apps",
    title: "Track every application",
    body: "Drafts, submissions, interviews, outcomes — all in one place. Status updates land here automatically.",
  },
];

function useTargetRect(targetId: string | null) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!targetId) return;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${targetId}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    // Sidebar can re-render (badge counts) — re-measure on a short interval
    // during the brief tour life rather than wiring a ResizeObserver everywhere.
    const id = window.setInterval(measure, 250);
    return () => {
      window.removeEventListener("resize", measure);
      window.clearInterval(id);
      setRect(null);
    };
  }, [targetId]);
  return rect;
}

export function OnboardingTour() {
  const step = useVantage((s) => s.tourStep);
  const nextStep = useVantage((s) => s.nextTourStep);
  const endTour = useVantage((s) => s.endTour);

  const current = step >= 0 && step < STEPS.length ? STEPS[step] : null;
  const rect = useTargetRect(current?.target ?? null);

  if (!current) return null;

  const popLeft = rect ? rect.right + 16 : typeof window !== "undefined" ? window.innerWidth / 2 - 160 : 0;
  const popTop = rect ? rect.top - 4 : typeof window !== "undefined" ? window.innerHeight / 2 - 80 : 0;
  const maxLeft = typeof window !== "undefined" ? window.innerWidth - 320 : popLeft;

  return (
    <>
      {/* Dim overlay; clicking it advances. */}
      <div
        onClick={nextStep}
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        style={{ pointerEvents: "auto" }}
      />

      {/* Spotlight ring around the anchor. The huge box-shadow visually "cuts
          through" the dim layer without needing SVG masking. */}
      {rect && (
        <div
          className="pointer-events-none fixed z-50 rounded-xl ring-2 ring-amber"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
          }}
        />
      )}

      {/* Popover card */}
      <div
        className="animate-pop fixed z-50 w-[300px] rounded-2xl border border-border bg-white p-5 shadow-xl"
        style={{ left: Math.min(popLeft, maxLeft), top: popTop }}
      >
        <p className="font-mono text-[10px] font-medium tracking-[1.5px] text-amber">
          STEP {step + 1} / {STEPS.length}
        </p>
        <h3 className="mt-2 font-display text-[17px] font-bold text-ink">{current.title}</h3>
        <p className="mt-2 font-body text-[13px] leading-relaxed text-ink-light">{current.body}</p>

        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={endTour}
            className="font-body text-[12px] text-ink-muted transition-colors hover:text-ink"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={nextStep}
            className="inline-flex items-center gap-1.5 rounded-full bg-brown px-4 py-2 font-body text-[13px] font-medium text-paper transition-opacity hover:opacity-90"
          >
            {step === STEPS.length - 1 ? "Got it" : "Next"}
            <ArrowRight size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
    </>
  );
}
