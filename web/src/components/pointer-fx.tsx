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
 *   5. Pointer-lit cards (v19) — a warm pool tracks the cursor across the
 *      pricing + differentiator cards (`data-glow`), so a whole grid lights up
 *      under the hand rather than each card waking only on direct hover.
 *   6. Kindled wake (v25) — the page reads how *fast* the hand is moving and
 *      lets the warm light answer. Pointer speed is differentiated into a
 *      smoothed `--pointer-heat` (0..1) on <html>; the continuous aura (effect
 *      7 below / the v21 field) reads it to bloom brighter and wider as the
 *      hand quickens — fanning the lamp — and a sparse trail of gold embers
 *      sheds from the cursor when the heat crests, drifting up and burning out.
 *      Both decay to nothing the instant the hand stills, so a resting page
 *      costs zero frames and is pixel-identical to before. This is the same
 *      forge/ember/lamp vocabulary the rest of the page already speaks, now
 *      made responsive to the reader's own tempo.
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

    const root = document.documentElement;
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

    // ── Pointer-lit cards (v19) ──────────────────────────────────────────────
    // A warm pool tracks the cursor across each `[data-glow]` card. Kept on the
    // direct path (no spring): a spotlight should sit *under* the cursor, not
    // trail it, so it reads as a held lamp rather than a lagging ghost. Writes
    // --gx/--gy (% within the card) and toggles data-glowing for the CSS fade.
    document.querySelectorAll<HTMLElement>("[data-glow]").forEach((el) => {
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--gx", `${((e.clientX - r.left) / r.width) * 100}%`);
        el.style.setProperty("--gy", `${((e.clientY - r.top) / r.height) * 100}%`);
        el.dataset.glowing = "true";
      };
      const onLeave = () => {
        el.dataset.glowing = "false";
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
      cleanups.push(() => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
      });
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

    // ── Living atmosphere + idle life (v21) ──────────────────────────────────
    // A single viewport-wide warm aura glides after the cursor on its own slow
    // spring, dissolving the per-section pools into one continuous light field —
    // the page reads as lit by a lamp the reader carries from top to bottom. The
    // node is appended to <body> here (no markup opts in) and rests transparent +
    // centred, so a no-JS page is untouched. Alongside it, the page gains *idle
    // life*: holding still flips `html[data-idle]` so the field eases into a slow
    // breath; the next cursor move clears it and resumes tracking.
    const aura = document.createElement("div");
    aura.className = "page-aura";
    aura.setAttribute("aria-hidden", "true");
    document.body.appendChild(aura);
    const auraSpring = makeSpring([50, 42], 0.08, (v) => {
      aura.style.setProperty("--px", `${v[0].toFixed(2)}%`);
      aura.style.setProperty("--py", `${v[1].toFixed(2)}%`);
    });
    const IDLE_MS = 2600; // stillness before the field settles into its breath
    let idleTimer = 0;
    const onAtmosphere = (e: PointerEvent) => {
      auraSpring.target[0] = (e.clientX / window.innerWidth) * 100;
      auraSpring.target[1] = (e.clientY / window.innerHeight) * 100;
      aura.dataset.active = "true";
      root.dataset.idle = "false";
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        root.dataset.idle = "true";
      }, IDLE_MS);
      wake();
    };
    const onAtmosphereLeave = () => {
      aura.dataset.active = "false";
      window.clearTimeout(idleTimer);
      root.dataset.idle = "false";
    };
    window.addEventListener("pointermove", onAtmosphere, { passive: true });
    // `mouseleave` on the document fires when the cursor exits the window, so the
    // field fades out instead of freezing at the last in-window position.
    document.addEventListener("mouseleave", onAtmosphereLeave);
    cleanups.push(() => {
      window.removeEventListener("pointermove", onAtmosphere);
      document.removeEventListener("mouseleave", onAtmosphereLeave);
      window.clearTimeout(idleTimer);
      aura.remove();
      delete root.dataset.idle;
    });

    // ── Kindled wake (v25) ───────────────────────────────────────────────────
    // The page already follows *where* the hand is (the v21 aura); v25 lets it
    // feel *how fast*. Each pointer move differentiates px-travelled / ms into an
    // impulse; a single rAF bleeds that energy back toward 0 with exponential
    // decay and publishes the smoothed value as `--pointer-heat` (0..1) on the
    // root. The CSS aura reads it to brighten + widen as the hand quickens, then
    // settles as it stills. The loop *parks itself* the instant heat returns to
    // rest, so a still page runs zero frames — same discipline as the scroll
    // momentum engine. Heat is built here rather than in the existing inertial
    // tick because it is a decaying scalar, not a target-seeking spring.
    let heat = 0;
    let hRaf = 0;
    let hx = 0;
    let hy = 0;
    let hT = performance.now();
    let primed = false; // skip the first sample so a teleport-in can't spike heat
    const HEAT_PEAK = 2.6; // px/ms that maps to full heat (a brisk flick)
    const HEAT_DECAY = 0.9; // fraction of heat retained per frame at rest
    const writeHeat = (v: number) =>
      root.style.setProperty("--pointer-heat", v.toFixed(3));

    // Ember wake: a capped, throttled pool of motes shed from the cursor while
    // the heat is high. Each is a single <span> appended to the aura node (which
    // is already fixed, full-viewport and pointer-transparent), positioned in
    // viewport px and self-removing on animationend — no per-frame bookkeeping.
    const MOTE_CAP = 14; // hard ceiling on concurrent motes (busyness guard)
    const MOTE_GAP = 55; // ms — minimum spacing between emissions
    let liveMotes = 0;
    let lastMote = 0;
    let lastMx = 0;
    let lastMy = 0;
    const shedMote = (x: number, y: number, now: number) => {
      if (liveMotes >= MOTE_CAP || now - lastMote < MOTE_GAP) return;
      lastMote = now;
      liveMotes++;
      const mote = document.createElement("span");
      mote.className = "wake-mote";
      // Scatter a touch off the exact cursor point and vary size/rise/drift so
      // the trail reads as live sparks, not a mechanical dotted line.
      const jitter = () => (Math.random() - 0.5) * 14;
      mote.style.left = `${x + jitter()}px`;
      mote.style.top = `${y + jitter()}px`;
      mote.style.setProperty("--m-size", `${(3 + Math.random() * 3).toFixed(1)}px`);
      mote.style.setProperty("--m-rise", `${(34 + Math.random() * 40).toFixed(0)}px`);
      mote.style.setProperty("--m-drift", `${(Math.random() - 0.5) * 26}px`);
      mote.style.setProperty("--m-dur", `${(0.85 + Math.random() * 0.7).toFixed(2)}s`);
      mote.addEventListener(
        "animationend",
        () => {
          mote.remove();
          liveMotes--;
        },
        { once: true },
      );
      aura.appendChild(mote);
    };

    const heatDecay = () => {
      hRaf = 0;
      heat *= HEAT_DECAY;
      if (heat < 0.005) {
        heat = 0;
        writeHeat(0);
        return; // settled — park the loop
      }
      writeHeat(heat);
      hRaf = requestAnimationFrame(heatDecay);
    };
    const onHeat = (e: PointerEvent) => {
      const now = performance.now();
      const x = e.clientX;
      const y = e.clientY;
      if (!primed) {
        primed = true;
        hx = x;
        hy = y;
        hT = now;
        lastMx = x;
        lastMy = y;
        return;
      }
      const dt = Math.max(now - hT, 1);
      const dist = Math.hypot(x - hx, y - hy);
      const v = dist / dt; // px/ms
      hx = x;
      hy = y;
      hT = now;
      heat = Math.min(1, Math.max(heat, heat * 0.5 + (v / HEAT_PEAK)));
      writeHeat(heat);
      if (!hRaf) hRaf = requestAnimationFrame(heatDecay);
      // Once warm enough, shed embers — and only along real travel, so a slow
      // drift never sparks. Sample a few points along the segment when the jump
      // is large so a fast fling still lays a continuous wake, not gaps.
      if (heat > 0.42) {
        const seg = Math.hypot(x - lastMx, y - lastMy);
        const steps = Math.min(3, Math.max(1, Math.floor(seg / 26)));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          shedMote(lastMx + (x - lastMx) * t, lastMy + (y - lastMy) * t, now);
        }
        lastMx = x;
        lastMy = y;
      } else {
        lastMx = x;
        lastMy = y;
      }
    };
    window.addEventListener("pointermove", onHeat, { passive: true });
    cleanups.push(() => {
      window.removeEventListener("pointermove", onHeat);
      if (hRaf) cancelAnimationFrame(hRaf);
      root.style.removeProperty("--pointer-heat");
    });

    // ── Carried filament (v30) ───────────────────────────────────────────────
    // The v21 aura is the broad lamp the reader carries; v30 hangs its bright
    // *filament* right under the cursor — a small, tight warm core that trails on
    // its own inertial spring, so the held light has a glowing wick, not just a
    // diffuse field. It rides the same `--pointer-heat` the rest of the page
    // reads (kindling brighter + tighter as the hand quickens) and fades with the
    // aura at the window's edge. Pointer-transparent, `screen`-blended (only ever
    // adds light) and pinned to viewport px in its own fixed node, so it never
    // disturbs layout or copy. Like every effect here it is gated to a fine
    // pointer with motion allowed, and rests fully transparent until the first
    // move, so a no-JS / reduced-motion page is pixel-identical.
    const filament = document.createElement("div");
    filament.className = "cursor-filament";
    filament.setAttribute("aria-hidden", "true");
    document.body.appendChild(filament);
    const filamentSpring = makeSpring(
      [window.innerWidth / 2, window.innerHeight / 2],
      0.22, // tighter than the aura's 0.08 — the wick stays close to the hand
      (v) => {
        filament.style.setProperty("--fx", `${v[0].toFixed(1)}px`);
        filament.style.setProperty("--fy", `${v[1].toFixed(1)}px`);
      },
    );
    const onFilament = (e: PointerEvent) => {
      filamentSpring.target[0] = e.clientX;
      filamentSpring.target[1] = e.clientY;
      filament.dataset.lit = "true";
      wake();
    };
    const onFilamentLeave = () => {
      filament.dataset.lit = "false";
    };
    window.addEventListener("pointermove", onFilament, { passive: true });
    document.addEventListener("mouseleave", onFilamentLeave);
    cleanups.push(() => {
      window.removeEventListener("pointermove", onFilament);
      document.removeEventListener("mouseleave", onFilamentLeave);
      filament.remove();
    });

    return () => {
      cleanups.forEach((fn) => fn());
      if (blobs.length) window.removeEventListener("pointermove", onWindowMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
