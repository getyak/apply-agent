"use client";

import { useEffect } from "react";

/**
 * PointerFX — a featherweight client island that makes the marketing page
 * respond to where the reader's pointer actually is. No state, no re-renders:
 * everything is written straight to node style / CSS custom properties for
 * 60fps cheapness.
 *
 *   1. Magnetic pull — primary CTAs (`data-magnetic`) lean a few pixels toward
 *      the cursor and spring back on leave, so they feel alive under the hand.
 *      Kept on the crisp CSS spring so a click still reads as a decisive press.
 *   2. Pointer tilt — the landing "device" mocks (`data-tilt`) tip in 3D toward
 *      the cursor, so they read as physical objects catching the light.
 *   3. Ambient cursor light — a warm pool (`.ambient-light`) glides across its
 *      host section, lighting the surface like a lamp the reader is holding.
 *   4. Aurora parallax — the decorative warm blobs (`data-parallax`) drift
 *      against the cursor for a sense of depth behind the hero.
 *
 * v13 — weighted light. Effects 2–4 used to write the raw cursor target every
 * frame, so the lean and the light *snapped* to the pointer. They now ride a
 * single shared inertial loop: each tracked value eases toward its target with
 * exponential smoothing, so motion carries mass and a trailing settle instead
 * of locking rigidly to the cursor. The loop parks itself the instant
 * everything is at rest (zero idle battery cost) and any input wakes it.
 *
 * Robustness + restraint: the whole layer is opt-in by data attribute / class,
 * only arms on a fine pointer with hover (so touch + keyboard users get the
 * calm static layout), and bails entirely under `prefers-reduced-motion`.
 * Because every effect drives a CSS custom property that defaults to its
 * neutral resting value, the page is pixel-identical to its no-JS state until
 * the cursor moves — progressive enhancement, never a dependency.
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

    // ── Inertial spring engine ───────────────────────────────────────────────
    // Every weighted value eases toward its target on a shared rAF loop with
    // simple exponential smoothing (`cur += (target - cur) * ease`). One loop
    // drives every spring; it parks the moment all of them settle and is woken
    // by any pointer input, so there is no idle cost when the cursor is still.
    type Spring = {
      cur: number[];
      target: number[];
      ease: number; // 0..1 — fraction of the gap closed each frame
      apply: (v: number[]) => void;
    };
    const springs: Spring[] = [];
    // Settle threshold. Generous enough that asymptotic tails snap cleanly so
    // the loop can park, fine enough to be sub-pixel / sub-degree invisible.
    const REST = 0.01;
    let raf = 0;

    const tick = () => {
      raf = 0;
      let moving = false;
      for (const s of springs) {
        for (let i = 0; i < s.cur.length; i++) {
          const delta = s.target[i] - s.cur[i];
          if (Math.abs(delta) > REST) {
            s.cur[i] += delta * s.ease;
            moving = true;
          } else if (s.cur[i] !== s.target[i]) {
            s.cur[i] = s.target[i];
            moving = true; // one last frame to paint the exact resting value
          }
        }
        s.apply(s.cur);
      }
      if (moving) raf = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const makeSpring = (
      init: number[],
      ease: number,
      apply: (v: number[]) => void,
    ): Spring => {
      const s: Spring = { cur: [...init], target: [...init], ease, apply };
      springs.push(s);
      return s;
    };

    // ── Magnetic CTAs ─────────────────────────────────────────────────────────
    // Left on the direct path + CSS spring: a CTA should meet the hand promptly
    // and click crisply; trailing inertia would only make the press feel mushy.
    document.querySelectorAll<HTMLElement>("[data-magnetic]").forEach((el) => {
      const strength = Number(el.dataset.magnetic) || 0.25;
      const cap = 14; // px — never let the pull get gimmicky
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const clamp = (v: number) =>
          Math.max(-cap, Math.min(cap, v * strength));
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

    // ── 3D pointer tilt (weighted) ───────────────────────────────────────────
    // The lean now eases toward the cursor angle, so the mock settles into place
    // with a hair of momentum like a real object on a gimbal.
    document.querySelectorAll<HTMLElement>("[data-tilt]").forEach((el) => {
      const max = Number(el.dataset.tilt) || 6; // degrees at the edges
      const sp = makeSpring([0, 0], 0.14, (v) => {
        el.style.setProperty("--tlt-x", `${v[0].toFixed(3)}deg`);
        el.style.setProperty("--tlt-y", `${v[1].toFixed(3)}deg`);
      });
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5; // -0.5 … 0.5
        const py = (e.clientY - r.top) / r.height - 0.5;
        sp.target[0] = -py * 2 * max; // rotateX leans away from the cursor Y
        sp.target[1] = px * 2 * max; //  rotateY leans toward the cursor X
        wake();
      };
      const onLeave = () => {
        sp.target[0] = 0;
        sp.target[1] = 0;
        wake();
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
      cleanups.push(() => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
      });
    });

    // ── Ambient cursor light (weighted) ──────────────────────────────────────
    // Each `.ambient-light` pool tracks the pointer across its host section, so
    // a whole surface feels lit by a lamp the reader is holding. The pool centre
    // now *glides* after the cursor (it used to teleport) for a liquid, lamp-on-
    // a-pendulum feel. data-lit fades the whole pool in/out at the section edge.
    document.querySelectorAll<HTMLElement>(".ambient-light").forEach((pool) => {
      const host = pool.parentElement;
      if (!host) return;
      const sp = makeSpring([50, 35], 0.1, (v) => {
        pool.style.setProperty("--ax", `${v[0].toFixed(2)}%`);
        pool.style.setProperty("--ay", `${v[1].toFixed(2)}%`);
      });
      const onMove = (e: PointerEvent) => {
        const r = host.getBoundingClientRect();
        sp.target[0] = ((e.clientX - r.left) / r.width) * 100;
        sp.target[1] = ((e.clientY - r.top) / r.height) * 100;
        pool.dataset.lit = "true";
        wake();
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

    // ── Press ripple ──────────────────────────────────────────────────────────
    // Anchor CTAs (`data-ripple`) aren't <Button>s, so they get their ripple
    // here: a warm bloom radiates from the contact point on press. The host is
    // already overflow-clipped (`.shine`), so we append the node straight to it.
    document.querySelectorAll<HTMLElement>("[data-ripple]").forEach((el) => {
      const onDown = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const size = Math.max(r.width, r.height) * 2.1;
        const dot = document.createElement("span");
        dot.className = "ripple";
        dot.style.setProperty("--rx", `${e.clientX - r.left}px`);
        dot.style.setProperty("--ry", `${e.clientY - r.top}px`);
        dot.style.setProperty("--rs", `${size}px`);
        dot.addEventListener("animationend", () => dot.remove(), { once: true });
        el.appendChild(dot);
      };
      el.addEventListener("pointerdown", onDown);
      cleanups.push(() => el.removeEventListener("pointerdown", onDown));
    });

    // ── Aurora parallax (weighted) ───────────────────────────────────────────
    // Writes the independent `translate` property so it layers on top of the
    // blobs' `transform`-based drift without conflict. Each blob now floats
    // toward its parallax target on a very slow spring, so the depth field
    // breathes rather than tracking the cursor 1:1.
    const blobs = Array.from(
      document.querySelectorAll<HTMLElement>("[data-parallax]"),
    ).map((el) => {
      const depth = Number(el.dataset.parallax) || 20;
      const sp = makeSpring([0, 0], 0.06, (v) => {
        el.style.translate = `${v[0].toFixed(2)}px ${v[1].toFixed(2)}px`;
      });
      return { depth, sp };
    });
    const onWindowMove = (e: PointerEvent) => {
      const cx = e.clientX / window.innerWidth - 0.5;
      const cy = e.clientY / window.innerHeight - 0.5;
      for (const b of blobs) {
        b.sp.target[0] = cx * b.depth;
        b.sp.target[1] = cy * b.depth;
      }
      wake();
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
