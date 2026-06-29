"use client";

/**
 * task-graph-card.tsx — the coordinator's plan (relay.task_graph). Each row
 * mirrors (bullet, label, status pill); rows animate as
 * relay.task_graph_step / relay.agent_* events advance them.
 *
 * Caller: step-card.tsx (kind === "plan"). Facts: no data-file IO; reads step.plan.
 */

import { useTranslations } from "next-intl";
import type { PlanStep, Step } from "@/lib/agent-events";
import { CardFrame } from "../step-card";

export function TaskGraphCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const plan = step.plan;
  if (!plan || plan.steps.length === 0) return null;
  return (
    <CardFrame testId="step-task-graph" surface={false}>
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #EDE8DF",
          borderRadius: 12,
          padding: "12px 14px",
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 10,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "#A39F99",
            marginBottom: 6,
          }}
        >
          {t("taskGraph.planHeader", { count: plan.steps.length })}
        </div>
        {plan.userGoal ? (
          <div
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 13,
              color: "#2B2822",
              marginBottom: 9,
            }}
          >
            {plan.userGoal}
          </div>
        ) : null}
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {plan.steps.map((s, i) => (
            <li
              key={s.step}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12.5,
                lineHeight: 1.5,
                padding: "3px 0",
                color: s.status === "pending" ? "#A39F99" : "#2B2822",
              }}
            >
              <div style={{ marginTop: 2 }}>
                <Bullet index={i + 1} status={s.status} />
              </div>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span
                  style={{
                    textDecoration: s.status === "done" ? "line-through" : "none",
                    textDecorationColor: s.status === "done" ? "#C9C2B5" : undefined,
                  }}
                >
                  {s.label}
                </span>
                {s.status === "failed" && s.errorText ? (
                  <span
                    className="ds-mono-9"
                    style={{ color: "#7A2A1F", lineHeight: 1.45 }}
                  >
                    {s.errorText}
                  </span>
                ) : null}
              </div>
              <Pill status={s.status} requiresReview={s.requiresReview} />
            </li>
          ))}
        </ol>
      </div>
    </CardFrame>
  );
}

function Bullet({ index, status }: { index: number; status: PlanStep["status"] }) {
  const common = {
    width: 16,
    height: 16,
    flexShrink: 0,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "JetBrains Mono, ui-monospace, monospace",
    fontSize: 9,
    lineHeight: 1,
  } as const;
  if (status === "done") {
    return (
      <span aria-hidden style={{ ...common, background: "#E2EED9", color: "#2F5722" }}>
        <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (status === "running") {
    return (
      <span aria-hidden className="animate-pulse" style={{ ...common, background: "#FBEFD8", color: "#5D3000" }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: "#5D3000" }} />
      </span>
    );
  }
  if (status === "review") {
    return (
      <span aria-hidden style={{ ...common, background: "#FBEFD0", color: "#8A6A12" }}>
        <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <circle cx={12} cy={12} r={9} />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span aria-hidden style={{ ...common, background: "#F4D7D2", color: "#7A2A1F" }}>
        <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <line x1={18} y1={6} x2={6} y2={18} />
          <line x1={6} y1={6} x2={18} y2={18} />
        </svg>
      </span>
    );
  }
  return (
    <span aria-hidden style={{ ...common, border: "1px solid #D6CFC0", color: "#A39F99" }}>
      {index}
    </span>
  );
}

function Pill({
  status,
  requiresReview,
}: {
  status: PlanStep["status"];
  requiresReview: boolean;
}) {
  const t = useTranslations("dock");
  const spec = (() => {
    if (status === "running") return { text: t("taskGraph.running"), fg: "#5D3000", bg: "#FBEFD8", anim: true };
    if (status === "done") return { text: t("taskGraph.done"), fg: "#2F5722", bg: "#E2EED9", anim: false };
    if (status === "review") return { text: t("taskGraph.review"), fg: "#8A6A12", bg: "#FBEFD0", anim: false };
    if (status === "failed") return { text: t("taskGraph.failed"), fg: "#7A2A1F", bg: "#F4D7D2", anim: false };
    return { text: requiresReview ? "HITL" : t("taskGraph.waiting"), fg: "#A39F99", bg: "#F4F0E8", anim: false };
  })();
  return (
    <span
      className={spec.anim ? "animate-pulse" : undefined}
      style={{
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 9.5,
        letterSpacing: 0.6,
        padding: "2px 7px",
        borderRadius: 999,
        color: spec.fg,
        background: spec.bg,
        flexShrink: 0,
      }}
    >
      {spec.text}
    </span>
  );
}
