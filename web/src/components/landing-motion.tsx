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

    // ── Scroll-spy nav (v37) ───────────────────────────────────────────────
    // The header anchors (#how / #chat / #features / #pricing) are dead until
    // clicked. This lights the one whose section the reader is currently in, so
    // the nav reads as a live position indicator — a warm gold marker that
    // travels with the read. Pure state (a `data-active-section` flag the CSS
    // styles), no motion of its own, so it's safe to run under reduced motion.
    // One observer with a band centred on the viewport: a section claims the nav
    // when its body crosses the middle third, so the active link flips at the
    // moment a section actually fills the page rather than the instant its top
    // edge peeks in.
    const navLinks = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[data-nav-link]"),
    );
    const linkFor = new Map<string, HTMLAnchorElement>();
    navLinks.forEach((a) => {
      const id = a.getAttribute("href")?.replace(/^#/, "");
      if (id) linkFor.set(id, a);
    });
    const spySections = Array.from(linkFor.keys())
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));
    let spy: IntersectionObserver | null = null;
    if (spySections.length) {
      const visible = new Map<string, number>();
      const setActive = (id: string | null) => {
        navLinks.forEach((a) => {
          const on = a.getAttribute("href") === `#${id}`;
          if (on) a.setAttribute("data-active-section", "true");
          else a.removeAttribute("data-active-section");
        });
      };
      spy = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).id;
            if (e.isIntersecting) visible.set(id, e.intersectionRatio);
            else visible.delete(id);
          }
          // The most-covered section in the centre band wins; ties go to the
          // one nearest the top so scrolling down advances the marker cleanly.
          let best: string | null = null;
          let bestRatio = 0;
          for (const [id, ratio] of visible) {
            if (ratio > bestRatio) {
              best = id;
              bestRatio = ratio;
            }
          }
          setActive(best);
        },
        { rootMargin: "-40% 0px -40% 0px", threshold: [0, 0.25, 0.5, 1] },
      );
      spySections.forEach((el) => spy!.observe(el));
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

    // ── Momentum engine (v20) ──────────────────────────────────────────────
    // Differentiate scroll position into a smoothed energy 0..1 and publish it
    // as `--scroll-energy`, so the rail + comet can feel how fast the reader is
    // flinging the page. Each scroll event adds an impulse sized by px/ms since
    // the last sample (clamped, so a giant jump can't spike past 1); a separate
    // rAF bleeds the energy back toward 0 with exponential decay and *parks the
    // instant it settles*, so there is zero idle cost when the page is still.
    // Gated behind !reduce so motion-sensitive readers never start the loop and
    // the CSS rests at its v7 hairline.
    let energy = 0;
    let lastY = root.scrollTop;
    let lastT = performance.now();
    let mRaf = 0;
    const PEAK = 2.4; // px/ms that maps to full energy (a hard fling)
    const DECAY = 0.86; // fraction of energy retained per frame at rest
    const writeEnergy = (v: number) =>
      root.style.setProperty("--scroll-energy", v.toFixed(3));
    const decay = () => {
      mRaf = 0;
      energy *= DECAY;
      if (energy < 0.004) {
        energy = 0;
        writeEnergy(0);
        return; // settled — park the loop
      }
      writeEnergy(energy);
      mRaf = requestAnimationFrame(decay);
    };
    const onMomentum = () => {
      const now = performance.now();
      const y = root.scrollTop;
      const dt = Math.max(now - lastT, 1);
      const v = Math.abs(y - lastY) / dt; // px/ms
      lastY = y;
      lastT = now;
      // Blend the new impulse in (rise fast, never above 1).
      energy = Math.min(1, Math.max(energy, energy * 0.4 + (v / PEAK) * 0.9));
      writeEnergy(energy);
      if (!mRaf) mRaf = requestAnimationFrame(decay);
    };
    if (!reduce) {
      window.addEventListener("scroll", onMomentum, { passive: true });
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onMomentum);
      if (raf) cancelAnimationFrame(raf);
      if (mRaf) cancelAnimationFrame(mRaf);
      io?.disconnect();
      spy?.disconnect();
      root.classList.remove("reveal-ready");
      root.style.removeProperty("--scroll-energy");
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
