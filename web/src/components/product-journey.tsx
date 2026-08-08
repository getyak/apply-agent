"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

export type ProductJourneyCopy = {
  eyebrow: string;
  title: string;
  subtitle: string;
  scenes: {
    tab: string;
    title: string;
    body: string;
    caption: string;
    alt: string;
  }[];
};

const SCENE_IMAGES = [
  "/demo/live-matches.png",
  "/demo/workspace.png",
  "/demo/application-review.png",
] as const;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export default function ProductJourney({ copy }: { copy: ProductJourneyCopy }) {
  const sceneRefs = useRef<(HTMLElement | null)[]>([]);
  const progressRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const activeRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    let frameId = 0;

    const measure = () => {
      frameId = 0;
      const scenes = sceneRefs.current.filter(
        (scene): scene is HTMLElement => Boolean(scene),
      );
      if (!scenes.length) return;

      const referenceLine = window.innerHeight * 0.46;
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;

      scenes.forEach((scene, index) => {
        const rect = scene.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - referenceLine);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });

      if (nearestIndex !== activeRef.current) {
        activeRef.current = nearestIndex;
        setActiveIndex(nearestIndex);
      }

      scenes.forEach((scene, index) => {
        const rect = scene.getBoundingClientRect();
        const activeProgress = clamp(
          (referenceLine - rect.top) / Math.max(rect.height * 0.76, 1),
        );
        const progress =
          index < nearestIndex ? 1 : index > nearestIndex ? 0 : activeProgress;
        progressRefs.current[index]?.style.setProperty(
          "transform",
          `scaleX(${progress})`,
        );
      });
    };

    const scheduleMeasure = () => {
      if (!frameId) frameId = window.requestAnimationFrame(measure);
    };

    document.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    measure();

    return () => {
      document.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, []);

  const goToScene = (index: number) => {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    sceneRefs.current[index]?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
    });
  };

  return (
    <section id="how" className="border-y border-border bg-white">
      <div className="mx-auto max-w-[1140px] px-6 py-16 sm:px-8 md:py-24">
        <div className="max-w-[760px]">
          <div className="mb-4 font-display text-xs font-bold uppercase tracking-[1.8px] text-amber">
            {copy.eyebrow}
          </div>
          <h2 className="m-0 max-w-[720px] text-balance font-display text-4xl font-bold leading-[1.02] tracking-[-1.2px] text-ink sm:text-5xl md:text-[58px]">
            {copy.title}
          </h2>
          <p className="m-0 mt-5 max-w-[590px] text-pretty font-body text-[17px] leading-[1.6] text-ink-light">
            {copy.subtitle}
          </p>
        </div>

        <div className="mt-14 grid items-start gap-10 md:mt-20 md:grid-cols-[280px_1fr] md:gap-14 lg:grid-cols-[320px_1fr] lg:gap-20">
          <nav
            aria-label={copy.eyebrow}
            className="sticky top-[66px] z-20 -mx-6 grid grid-cols-3 border-y border-border bg-white/94 px-6 backdrop-blur-md md:top-[102px] md:z-auto md:mx-0 md:block md:border-0 md:bg-transparent md:px-0 md:backdrop-blur-none"
          >
            {copy.scenes.map((scene, index) => {
              const state =
                index < activeIndex
                  ? "complete"
                  : index === activeIndex
                    ? "active"
                    : "upcoming";
              return (
                <button
                  key={scene.tab}
                  type="button"
                  aria-current={state === "active" ? "step" : undefined}
                  onClick={() => goToScene(index)}
                  className={`group min-h-14 cursor-pointer border-0 border-b border-border bg-transparent px-2 py-3 text-left font-body text-xs font-semibold transition-colors sm:px-3 sm:text-sm md:min-h-0 md:w-full md:px-0 md:py-5 md:text-base ${
                    state === "active"
                      ? "text-ink"
                      : state === "complete"
                        ? "text-brown"
                        : "text-ink-muted hover:text-ink-light"
                  }`}
                >
                  <span className="block">{scene.tab}</span>
                  <span
                    aria-hidden
                    className="mt-3 hidden h-px w-full overflow-hidden bg-border md:block"
                  >
                    <span
                      ref={(node) => {
                        progressRefs.current[index] = node;
                      }}
                      className="block h-full w-full origin-left bg-brown will-change-transform"
                      style={{ transform: index === 0 ? "scaleX(0.08)" : "scaleX(0)" }}
                    />
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="grid gap-20 md:gap-28">
            {copy.scenes.map((scene, index) => (
              <article
                key={scene.title}
                ref={(node) => {
                  sceneRefs.current[index] = node;
                }}
                className="scroll-mt-40 md:min-h-[760px]"
              >
                <div className="max-w-[610px]">
                  <h3 className="m-0 font-display text-[28px] font-bold leading-[1.08] tracking-[-0.7px] text-ink sm:text-[34px]">
                    {scene.title}
                  </h3>
                  <p className="m-0 mt-3 text-pretty font-body text-base leading-[1.6] text-ink-light">
                    {scene.body}
                  </p>
                </div>

                <figure className="mt-7">
                  <div
                    className={`relative aspect-[8/5] overflow-hidden rounded-[16px] border border-[#d8cdbd] bg-paper shadow-[0_28px_70px_-38px_rgba(61,42,20,0.58)] ${
                      index === 2 ? "journey-push-scene" : ""
                    }`}
                  >
                    <Image
                      src={SCENE_IMAGES[index]}
                      alt={scene.alt}
                      fill
                      sizes="(min-width: 1024px) 660px, (min-width: 768px) 58vw, 100vw"
                      className={`object-cover ${
                        index === 2
                          ? "journey-push-primary"
                          : index === 1
                            ? "object-left"
                            : ""
                      }`}
                    />
                    {index === 2 && (
                      <div
                        aria-hidden
                        className="journey-agent-layer absolute -bottom-[21%] -right-[6%] h-[58%] w-[112%] overflow-hidden rounded-t-[14px] border border-b-0 border-[#cbbda9] bg-white shadow-[0_-22px_48px_-30px_rgba(43,40,34,0.58)]"
                      >
                        <Image
                          src="/demo/workspace.png"
                          alt=""
                          fill
                          sizes="760px"
                          className="object-cover object-right"
                        />
                      </div>
                    )}
                  </div>
                  <figcaption className="mt-3 font-mono text-[10px] uppercase tracking-[0.7px] text-ink-muted">
                    {scene.caption}
                  </figcaption>
                </figure>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
