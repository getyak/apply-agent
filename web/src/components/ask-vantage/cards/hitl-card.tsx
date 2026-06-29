"use client";

/**
 * hitl-card.tsx — inline Human-in-the-Loop card. The reducer creates a
 * "hitl" step from RUN_FINISHED(outcome=interrupt). Three variants share
 * one card chrome: ask_user (chips + free text), diff (before/after +
 * approve/tweak/discard), approval (confirm + optional reason).
 *
 * Resume model (plan constraint #9): submitting fires a NEW run via
 * sendResume(threadId, decision) → POST /api/ask/stream
 * {thread_id, command: {resume: <decision>}}. The continuation folds into
 * the same step graph.
 *
 * Caller: step-card.tsx (kind === "hitl").
 * Facts: no data-file IO; reads step.hitl.{reason,message,metadata}; writes
 * a resume decision over the network only.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Step } from "@/lib/agent-events";
import { sendResume, useAgentStream } from "@/lib/agent-events";
import { useDock } from "@/lib/ask-vantage-store";
import { CardFrame } from "../step-card";

type Variant = "ask_user" | "diff" | "approval";

interface HitlMeta {
  kind?: Variant;
  question?: string;
  chips?: string[];
  free_form?: boolean;
  before?: unknown;
  after?: unknown;
  action?: string;
  payload?: unknown;
}

function variantOf(meta: HitlMeta, reason: string): Variant {
  if (meta.kind === "ask_user" || meta.kind === "diff" || meta.kind === "approval") {
    return meta.kind;
  }
  // Fall back to the reason string the agent emitted.
  if (reason.includes("diff")) return "diff";
  if (reason.includes("ask")) return "ask_user";
  return "approval";
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function HitlCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const hitl = step.hitl;
  const meta = (hitl?.metadata ?? {}) as HitlMeta;
  const variant = variantOf(meta, hitl?.reason ?? "");
  // A resolved decision is captured on the step once the user acts; the
  // card greys out so it can't be re-submitted.
  const decided = hitl?.decision !== undefined;
  const [busy, setBusy] = useState(false);
  const threadId = useDock((s) => s.threadId);

  const submit = async (decision: unknown) => {
    if (busy || decided || !threadId) return;
    setBusy(true);
    // Stamp the decision locally so the card locks even before the resume
    // stream lands. The reducer doesn't track decisions, so we mutate the
    // step in place via the store.
    const cur = useAgentStream.getState();
    const s = cur.steps.get(step.id);
    if (s && s.hitl) {
      const steps = new Map(cur.steps);
      steps.set(step.id, {
        ...s,
        status: "done",
        hitl: { ...s.hitl, decision },
      });
      useAgentStream.setState({ steps });
    }
    try {
      await sendResume(threadId, decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardFrame testId={`step-hitl-${variant}`} surface={false}>
      <div
        data-status={decided ? "answered" : "pending"}
        style={{
          border: "1px solid #D6CFC0",
          background: decided ? "#F4F1EA" : "#FBF8F3",
          borderRadius: 12,
          padding: 14,
          opacity: decided ? 0.7 : 1,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span
            className="ds-mono-10"
            style={{ color: "#5D3000", textTransform: "uppercase", letterSpacing: 0.6 }}
          >
            {variant === "ask_user"
              ? t("hitl.titleAskUser")
              : variant === "diff"
                ? t("hitl.titleDiff")
                : t("hitl.titleApproval")}
          </span>
          <span
            className="ds-mono-9"
            style={{
              padding: "2px 7px",
              borderRadius: 999,
              background: decided ? "#E2EED9" : "#E1E8F0",
              color: decided ? "#2F5722" : "#2A4759",
            }}
          >
            {decided ? t("hitl.statusAnswered") : t("hitl.statusAwaiting")}
          </span>
        </div>

        {variant === "ask_user" ? (
          <AskUserBody meta={meta} locked={decided || busy} onSubmit={submit} />
        ) : variant === "diff" ? (
          <DiffBody meta={meta} locked={decided || busy} onSubmit={submit} />
        ) : (
          <ApprovalBody
            meta={meta}
            message={hitl?.message}
            locked={decided || busy}
            onSubmit={submit}
          />
        )}
      </div>
    </CardFrame>
  );
}

function AskUserBody({
  meta,
  locked,
  onSubmit,
}: {
  meta: HitlMeta;
  locked: boolean;
  onSubmit: (v: unknown) => void;
}) {
  const t = useTranslations("dock");
  const [text, setText] = useState("");
  return (
    <div>
      {meta.question ? (
        <p style={{ marginBottom: 10, color: "#2B2822", fontFamily: "Inter, system-ui, sans-serif", fontSize: 13.5 }}>
          {meta.question}
        </p>
      ) : null}
      {meta.chips && meta.chips.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 }}>
          {meta.chips.map((chip) => (
            <button
              key={chip}
              type="button"
              data-testid={`hitl-chip-${chip}`}
              disabled={locked}
              onClick={() => onSubmit({ type: "answer", value: chip })}
              style={chipStyle(locked)}
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}
      {meta.free_form !== false ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onSubmit({ type: "answer", value: text.trim() });
          }}
          style={{ display: "flex", gap: 7 }}
        >
          <input
            data-testid="hitl-free-form-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={locked}
            placeholder={t("hitl.answerPlaceholder")}
            style={inputStyle(locked)}
          />
          <button
            type="submit"
            data-testid="hitl-free-form-send"
            disabled={locked || !text.trim()}
            style={primaryBtnStyle(locked || !text.trim())}
          >
            {t("hitl.send")}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function DiffBody({
  meta,
  locked,
  onSubmit,
}: {
  meta: HitlMeta;
  locked: boolean;
  onSubmit: (v: unknown) => void;
}) {
  const t = useTranslations("dock");
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <DiffPane label={t("hitl.before")} value={meta.before} testId="before" />
        <DiffPane label={t("hitl.after")} value={meta.after} testId="after" />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        <button
          type="button"
          data-testid="hitl-diff-approve"
          disabled={locked}
          onClick={() => onSubmit({ type: "approve" })}
          style={approveBtnStyle(locked)}
        >
          {t("hitl.approve")}
        </button>
        <button
          type="button"
          data-testid="hitl-diff-tweak"
          disabled={locked}
          onClick={() => onSubmit({ type: "tweak" })}
          style={neutralBtnStyle(locked)}
        >
          {t("hitl.askToTweak")}
        </button>
        <button
          type="button"
          data-testid="hitl-diff-discard"
          disabled={locked}
          onClick={() => onSubmit({ type: "discard" })}
          style={dangerBtnStyle(locked)}
        >
          {t("hitl.discard")}
        </button>
      </div>
    </div>
  );
}

function ApprovalBody({
  meta,
  message,
  locked,
  onSubmit,
}: {
  meta: HitlMeta;
  message?: string;
  locked: boolean;
  onSubmit: (v: unknown) => void;
}) {
  const t = useTranslations("dock");
  const [reason, setReason] = useState("");
  return (
    <div>
      <p style={{ marginBottom: 8, color: "#2B2822", fontFamily: "Inter, system-ui, sans-serif", fontSize: 13.5 }}>
        {message ??
          (meta.action
            ? t.rich("hitl.wantsTo", {
                action: meta.action,
                strong: (chunks) => <strong>{chunks}</strong>,
              })
            : "")}
      </p>
      {meta.payload !== undefined && meta.payload !== null ? (
        <pre
          data-testid="hitl-approval-payload"
          style={{
            margin: "0 0 10px",
            maxHeight: 128,
            overflow: "auto",
            borderRadius: 8,
            border: "1px solid #EDE8DF",
            background: "#FFFFFF",
            padding: 8,
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 11,
          }}
        >
          {renderValue(meta.payload)}
        </pre>
      ) : null}
      <input
        data-testid="hitl-approval-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={locked}
        placeholder={t("hitl.optionalNote")}
        style={{ ...inputStyle(locked), width: "100%", marginBottom: 10 }}
      />
      <div style={{ display: "flex", gap: 7 }}>
        <button
          type="button"
          data-testid="hitl-approval-approve"
          disabled={locked}
          onClick={() =>
            onSubmit({ type: "approve", ...(reason.trim() ? { reason: reason.trim() } : {}) })
          }
          style={approveBtnStyle(locked)}
        >
          {t("hitl.approve")}
        </button>
        <button
          type="button"
          data-testid="hitl-approval-reject"
          disabled={locked}
          onClick={() =>
            onSubmit({ type: "reject", ...(reason.trim() ? { reason: reason.trim() } : {}) })
          }
          style={dangerBtnStyle(locked)}
        >
          {t("hitl.reject")}
        </button>
      </div>
    </div>
  );
}

function DiffPane({ label, value, testId }: { label: string; value: unknown; testId: string }) {
  return (
    <div style={{ border: "1px solid #EDE8DF", borderRadius: 8, background: "#FFFFFF", padding: 8 }}>
      <div className="ds-mono-9" style={{ color: "#A39F99", marginBottom: 4 }}>
        {label}
      </div>
      <pre
        data-testid={`diff-${testId}`}
        style={{
          margin: 0,
          maxHeight: 128,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          fontSize: 11,
          color: "#2B2822",
        }}
      >
        {renderValue(value)}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- styles

function chipStyle(disabled: boolean): React.CSSProperties {
  return {
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid #D6CEC0",
    background: "#FFFFFF",
    borderRadius: 999,
    padding: "5px 12px",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 12,
    color: "#2B2822",
    opacity: disabled ? 0.5 : 1,
  };
}
function inputStyle(disabled: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    border: "1px solid #D6CEC0",
    borderRadius: 8,
    padding: "6px 9px",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 12,
    color: "#2B2822",
    background: "#FFFFFF",
    opacity: disabled ? 0.5 : 1,
  };
}
function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid #5D3000",
    background: "#5D3000",
    color: "#FFFFFF",
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: 600,
    fontSize: 12,
    padding: "6px 11px",
    borderRadius: 8,
    opacity: disabled ? 0.5 : 1,
  };
}
function approveBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid #4C7A3F",
    background: "#4C7A3F",
    color: "#FFFFFF",
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: 600,
    fontSize: 12,
    padding: "5px 12px",
    borderRadius: 8,
    opacity: disabled ? 0.5 : 1,
  };
}
function neutralBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid #D6CEC0",
    background: "#FFFFFF",
    color: "#2B2822",
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: 600,
    fontSize: 12,
    padding: "5px 12px",
    borderRadius: 8,
    opacity: disabled ? 0.5 : 1,
  };
}
function dangerBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid #E2C1BB",
    background: "#FFFFFF",
    color: "#7A2A1F",
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: 600,
    fontSize: 12,
    padding: "5px 12px",
    borderRadius: 8,
    opacity: disabled ? 0.5 : 1,
  };
}
