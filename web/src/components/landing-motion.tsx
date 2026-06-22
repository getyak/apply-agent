"use client";

import { useEffect } from "react";

/**
 * LandingMotion — the marketing page's choreography layer. Three effects, one
 * client island, zero layout cost:
 *
 *   1. Scroll-progress rail — a thin warm-gold bar pinned to the very top that
 *      fills left→right as you travel the page. Premium, glanceable "how far in
 *      am I" feedback.
 *   2. Scroll-reveal — sections + cards carrying `data-reveal` rise + un-blur
 *      into place the first time they enter the viewport (once, then we stop
 *      observing). Delays are read from each element's `--reveal-delay` so grids
 *      cascade instead of snapping in together.
 *   3. Nav condense — the sticky header tightens and grows a shadow once the
 *      page has scrolled, so it reads as "lifted off the page" while reading.
 *
 * Robustness: the hidden pre-reveal state is armed by adding `reveal-ready` to
 * <html> only after this island mounts. If JS never runs, nothing is hidden and
 * the page renders fully — progressive enhancement, not a JS dependency. The
 * whole layer also yields to `prefers-reduced-motion`.
 */
export default function LandingMotion() {
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Arm the hidden-until-revealed state now that JS is live.
    root.classList.add("reveal-ready");

    // ── Scroll-reveal ──────────────────────────────────────────────────────
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    let io: IntersectionObserver | null = null;
    if (reduce) {
      targets.forEach((el) => el.classList.add("revealed"));
    } else {
      io = new IntersectionObserver(
        (entries, obs) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("revealed");
              obs.unobserve(entry.target);
            }
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
      );
      targets.forEach((el) => io!.observe(el));
    }

    // ── Scroll-progress + comet head + nav condense ────────────────────────
    const bar = document.getElementById("scroll-progress");
    const comet = document.getElementById("scroll-comet");
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const max = root.scrollHeight - root.clientHeight;
        const progress = max > 0 ? Math.min(root.scrollTop / max, 1) : 0;
        if (bar) bar.style.transform = `scaleX(${progress})`;
        // The comet rides the leading edge of the filled rail.
        if (comet) comet.style.left = `${progress * 100}%`;
        root.dataset.scrolled = root.scrollTop > 8 ? "true" : "false";
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      root.classList.remove("reveal-ready");
      delete root.dataset.scrolled;
    };
  }, []);

  return (
    <>
      <div id="scroll-progress" className="scroll-progress" aria-hidden />
      <div id="scroll-comet" className="scroll-comet" aria-hidden />
    </>
  );
}
