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
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );

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
        const progress = reduceMotion.matches
          ? index <= nearestIndex
            ? 1
            : 0
          : index < nearestIndex
            ? 1
            : index > nearestIndex
              ? 0
              : activeProgress;

        progressRefs.current[index]?.style.setProperty(
          "transform",
          `scaleX(${progress})`,
        );
      });
    };

    const scheduleMeasure = () => {
      if (!frameId) frameId = window.requestAnimationFrame(measure);
    };

    window.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    reduceMotion.addEventListener("change", scheduleMeasure);
    measure();

    return () => {
      window.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      reduceMotion.removeEventListener("change", scheduleMeasure);
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
    <section
      id="how"
      aria-label={copy.eyebrow}
      className="border-b border-[var(--landing-line)] bg-[var(--landing-surface)]"
    >
      <div className="mx-auto max-w-[1320px] px-5 py-24 sm:px-8 md:py-32">
        <h2 className="m-0 max-w-[840px] text-balance font-display text-[clamp(2.8rem,5vw,4.9rem)] font-bold leading-[0.96] tracking-[-0.055em] text-[var(--landing-ink)]">
          {copy.title}
        </h2>
        <p className="mb-0 mt-5 max-w-[650px] text-[17px] leading-[1.6] text-[var(--landing-muted)]">
          {copy.subtitle}
        </p>

        <div className="mt-16 grid items-start gap-10 md:mt-20 md:grid-cols-[280px_1fr] md:gap-14 lg:grid-cols-[320px_1fr] lg:gap-20">
          <nav
            aria-label={copy.eyebrow}
            className="sticky top-[70px] z-20 -mx-5 grid grid-cols-3 border-y border-[var(--landing-line)] bg-[var(--landing-surface)] px-5 sm:-mx-8 sm:px-8 md:top-[110px] md:z-auto md:mx-0 md:block md:border-0 md:bg-transparent md:px-0"
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
                  className={`group min-h-14 cursor-pointer border-0 border-b-2 bg-transparent px-2 py-3 text-left text-[12px] font-semibold transition-colors duration-200 sm:px-3 sm:text-[13px] md:min-h-0 md:w-full md:border-b md:border-[var(--landing-line)] md:px-0 md:py-5 md:text-[16px] ${
                    state === "active"
                      ? "border-[var(--landing-accent)] text-[var(--landing-ink)] md:border-[var(--landing-line)]"
                      : state === "complete"
                        ? "border-transparent text-[var(--landing-accent)] md:border-[var(--landing-line)]"
                        : "border-transparent text-[var(--landing-subtle)] hover:text-[var(--landing-ink)] md:border-[var(--landing-line)]"
                  }`}
                >
                  <span className="block">{scene.tab}</span>
                  <span
                    aria-hidden
                    className="mt-3 hidden h-[2px] w-full overflow-hidden bg-[var(--landing-line)] md:block"
                  >
                    <span
                      ref={(node) => {
                        progressRefs.current[index] = node;
                      }}
                      className="block h-full w-full origin-left bg-[var(--landing-accent)] will-change-transform"
                      style={{
                        transform:
                          index === 0 ? "scaleX(0.08)" : "scaleX(0)",
                      }}
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
                className="scroll-mt-40 md:min-h-[780px]"
              >
                <div className="max-w-[650px]">
                  <h3 className="m-0 font-display text-[30px] font-semibold leading-[1.05] tracking-[-0.035em] text-[var(--landing-ink)] sm:text-[38px]">
                    {scene.title}
                  </h3>
                  <p className="mb-0 mt-3 text-[16px] leading-[1.65] text-[var(--landing-muted)]">
                    {scene.body}
                  </p>
                </div>

                <figure className="mt-7">
                  <div
                    className={`relative aspect-[8/5] overflow-hidden rounded-[var(--landing-frame-radius)] border border-[var(--landing-line-strong)] bg-[var(--landing-bg)] shadow-[var(--landing-shadow)] ${
                      index === 2 ? "journey-push-scene" : ""
                    }`}
                  >
                    <Image
                      src={SCENE_IMAGES[index]}
                      alt={scene.alt}
                      fill
                      sizes="(min-width: 1024px) 800px, (min-width: 768px) 64vw, 100vw"
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
                        className="journey-agent-layer absolute -bottom-[21%] -right-[6%] h-[58%] w-[112%] overflow-hidden rounded-t-[14px] border border-b-0 border-[var(--landing-line-strong)] bg-[var(--landing-surface)] shadow-[0_-22px_48px_-30px_rgba(24,32,26,0.4)]"
                      >
                        <Image
                          src="/demo/workspace.png"
                          alt=""
                          fill
                          sizes="860px"
                          className="object-cover object-right"
                        />
                      </div>
                    )}
                  </div>
                  <figcaption className="mt-3 text-[12px] text-[var(--landing-subtle)]">
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
