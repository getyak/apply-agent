"use client";

import { useEffect } from "react";

/**
 * PointerFX — a featherweight client island that makes the marketing page
 * respond to where the reader's pointer actually is. Three effects, no state,
 * no re-renders (everything is written straight to node style / CSS custom
 * properties for 60fps cheapness):
 *
 *   1. Magnetic pull — primary CTAs (`data-magnetic`) lean a few pixels toward
 *      the cursor and spring back on leave, so they feel alive under the hand.
 *   2. Pointer tilt — the landing "device" mocks (`data-tilt`) tip in 3D toward
 *      the cursor, so they read as physical objects catching the light.
 *   3. Aurora parallax — the decorative warm blobs (`data-parallax`) drift
 *      against the cursor for a sense of depth behind the hero.
 *
 * Robustness + restraint: the whole layer is opt-in by data attribute, only
 * arms on a fine pointer with hover (so touch + keyboard users get the calm
 * static layout), and bails entirely under `prefers-reduced-motion`. Because
 * every effect drives a CSS custom property that defaults to its neutral
 * resting value, the page is pixel-identical to its no-JS state until the
 * cursor moves — progressive enhancement, never a dependency.
 */
export default function PointerFX() {
  useEffect(() => {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const finePointer = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    ).matches;
    if (reduce || !finePointer) return;

    const cleanups: Array<() => void> = [];

    // ── Magnetic CTAs ───────────────────────────────────────────────────────
    document
      .querySelectorAll<HTMLElement>("[data-magnetic]")
      .forEach((el) => {
        const strength = Number(el.dataset.magnetic) || 0.25;
        const cap = 14; // px — never let the pull get gimmicky
        const onMove = (e: PointerEvent) => {
          const r = el.getBoundingClientRect();
          const dx = e.clientX - (r.left + r.width / 2);
          const dy = e.clientY - (r.top + r.height / 2);
          const clamp = (v: number) => Math.max(-cap, Math.min(cap, v * strength));
          el.style.setProperty("--mag-x", `${clamp(dx)}px`);
          el.style.setProperty("--mag-y", `${clamp(dy)}px`);
        };
        const onLeave = () => {
          el.style.setProperty("--mag-x", "0px");
          el.style.setProperty("--mag-y", "0px");
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerleave", onLeave);
        cleanups.push(() => {
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerleave", onLeave);
        });
      });

    // ── 3D pointer tilt ─────────────────────────────────────────────────────
    document.querySelectorAll<HTMLElement>("[data-tilt]").forEach((el) => {
      const max = Number(el.dataset.tilt) || 6; // degrees at the edges
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5; // -0.5 … 0.5
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.setProperty("--tlt-y", `${px * 2 * max}deg`);
        el.style.setProperty("--tlt-x", `${-py * 2 * max}deg`);
      };
      const onLeave = () => {
        el.style.setProperty("--tlt-x", "0deg");
        el.style.setProperty("--tlt-y", "0deg");
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
      cleanups.push(() => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
      });
    });

    // ── Ambient cursor light ────────────────────────────────────────────────
    // Each `.ambient-light` pool tracks the pointer across its host section, so
    // a whole surface feels lit by a lamp the reader is holding. We write %s so
    // the gradient's no-JS resting position stays valid, and toggle data-lit so
    // it fades out cleanly when the cursor leaves the section.
    document
      .querySelectorAll<HTMLElement>(".ambient-light")
      .forEach((pool) => {
        const host = pool.parentElement;
        if (!host) return;
        const onMove = (e: PointerEvent) => {
          const r = host.getBoundingClientRect();
          const ax = ((e.clientX - r.left) / r.width) * 100;
          const ay = ((e.clientY - r.top) / r.height) * 100;
          pool.style.setProperty("--ax", `${ax}%`);
          pool.style.setProperty("--ay", `${ay}%`);
          pool.dataset.lit = "true";
        };
        const onLeave = () => {
          pool.dataset.lit = "false";
        };
        host.addEventListener("pointermove", onMove);
        host.addEventListener("pointerleave", onLeave);
        cleanups.push(() => {
          host.removeEventListener("pointermove", onMove);
          host.removeEventListener("pointerleave", onLeave);
        });
      });

    // ── Aurora parallax ─────────────────────────────────────────────────────
    // Uses the independent `translate` property so it composes cleanly with the
    // blobs' existing `transform`-driven drift animation instead of fighting it.
    const blobs = Array.from(
      document.querySelectorAll<HTMLElement>("[data-parallax]"),
    );
    let raf = 0;
    const onWindowMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const cx = e.clientX / window.innerWidth - 0.5;
        const cy = e.clientY / window.innerHeight - 0.5;
        for (const el of blobs) {
          const depth = Number(el.dataset.parallax) || 20;
          el.style.translate = `${cx * depth}px ${cy * depth}px`;
        }
      });
    };
    if (blobs.length) {
      window.addEventListener("pointermove", onWindowMove, { passive: true });
    }

    return () => {
      cleanups.forEach((fn) => fn());
      if (blobs.length) window.removeEventListener("pointermove", onWindowMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
