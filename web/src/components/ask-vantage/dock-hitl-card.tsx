"use client";

/**
 * Inline HITL bubble for the dock.
 *
 * Why this lives in its own file:
 *   - Keeps ``dock.tsx`` from growing past its 2k-line cliff.
 *   - The HITL bubbles are unit-testable in isolation (the dock isn't —
 *     it depends on Zustand persistence, file-upload IO, etc).
 *   - Three variants share the same chrome (header + resume_token +
 *     status pill) so colocating them is cheaper than spreading them
 *     across three sibling files.
 *
 * One bubble per kind:
 *   - ``hitl_ask_user``  → chip list + free-form text input
 *   - ``hitl_diff``      → before / after panes + Approve / Tweak / Discard
 *   - ``hitl_approval``  → single action confirm with optional reason
 *
 * All three call ``respondToHitl`` (or ``cancelHitl``); none of them
 * navigate. The dock never leaves the conversation flow.
 */

import { useState } from "react";

import { cancelHitl, respondToHitl } from "@/lib/ask-stream";
import type { DockMessage, HitlStatus } from "@/lib/ask-vantage-store";

type Variant = "ask_user" | "diff" | "approval";

interface Props {
  m: DockMessage;
}

export function HitlCard({ m }: Props) {
  const variant: Variant | null =
    m.kind === "hitl_ask_user"
      ? "ask_user"
      : m.kind === "hitl_diff"
        ? "diff"
        : m.kind === "hitl_approval"
          ? "approval"
          : null;
  if (!variant) return null;
  if (!m.resumeToken) {
    return (
      <div
        className="my-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs"
        data-testid="hitl-error"
      >
        HITL surface missing resume_token — agent emitted an interrupt with
        no resumable thread. This is a wiring bug; please retry or report.
      </div>
    );
  }

  const status: HitlStatus = m.hitlStatus ?? "pending";
  const locked = status !== "pending";

  return (
    <div
      data-testid={`hitl-card-${variant}`}
      data-status={status}
      className="my-2 rounded-md border border-stone-300 bg-stone-50/90 p-4 text-sm"
    >
      <Header variant={variant} status={status} />
      {variant === "ask_user" && <AskUserBody m={m} locked={locked} />}
      {variant === "diff" && <DiffBody m={m} locked={locked} />}
      {variant === "approval" && <ApprovalBody m={m} locked={locked} />}
      {locked && m.hitlAnswerSummary && (
        <p
          className="mt-3 border-t border-stone-200 pt-2 text-xs italic text-stone-600"
          data-testid="hitl-answer-summary"
        >
          You responded: {m.hitlAnswerSummary}
        </p>
      )}
    </div>
  );
}

function Header({
  variant,
  status,
}: {
  variant: Variant;
  status: HitlStatus;
}) {
  const title =
    variant === "ask_user"
      ? "Vantage needs your input"
      : variant === "diff"
        ? "Review the change"
        : "Approve next step";
  return (
    <div className="mb-3 flex items-center justify-between">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-700">
        {title}
      </h4>
      <StatusPill status={status} />
    </div>
  );
}

function StatusPill({ status }: { status: HitlStatus }) {
  const spec =
    status === "answered"
      ? { label: "Answered", bg: "#E2EED9", fg: "#2F5722" }
      : status === "submitting"
        ? { label: "Submitting…", bg: "#FBEFD0", fg: "#8A6A12" }
        : status === "cancelled"
          ? { label: "Cancelled", bg: "#F1EAE3", fg: "#6B5B49" }
          : { label: "Awaiting you", bg: "#E1E8F0", fg: "#2A4759" };
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={{ background: spec.bg, color: spec.fg }}
    >
      {spec.label}
    </span>
  );
}

function AskUserBody({ m, locked }: { m: DockMessage; locked: boolean }) {
  const payload = m.hitlAskUser;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!payload) return null;

  const submit = async (value: string | string[]) => {
    if (!m.resumeToken || busy) return;
    setBusy(true);
    const summary = Array.isArray(value) ? value.join(", ") : value;
    try {
      await respondToHitl(m.id, m.resumeToken, value, summary);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="mb-3 text-stone-800">{payload.question}</p>
      {payload.chips && payload.chips.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {payload.chips.map((chip) => (
            <button
              key={chip}
              type="button"
              data-testid={`hitl-chip-${chip}`}
              disabled={locked || busy}
              onClick={() => void submit(chip)}
              className="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {chip}
            </button>
          ))}
        </div>
      )}
      {payload.freeForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void submit(text.trim());
          }}
          className="flex gap-2"
        >
          <input
            data-testid="hitl-free-form-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={locked || busy}
            className="flex-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm disabled:opacity-50"
            placeholder="Type your answer…"
          />
          <button
            data-testid="hitl-free-form-send"
            type="submit"
            disabled={locked || busy || !text.trim()}
            className="rounded-md bg-stone-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
      <CancelLink m={m} locked={locked} />
    </div>
  );
}

function DiffBody({ m, locked }: { m: DockMessage; locked: boolean }) {
  const payload = m.hitlDiff;
  const [busy, setBusy] = useState(false);
  if (!payload) return null;

  const decide = async (decision: "approve" | "tweak" | "discard") => {
    if (!m.resumeToken || busy) return;
    setBusy(true);
    const value: Record<string, unknown> = { decision };
    try {
      await respondToHitl(
        m.id,
        m.resumeToken,
        value,
        decision === "approve"
          ? "Approved"
          : decision === "tweak"
            ? "Asked to tweak"
            : "Discarded",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <DiffPane label="Before" value={payload.before} />
        <DiffPane label="After" value={payload.after} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="hitl-diff-approve"
          disabled={locked || busy}
          onClick={() => void decide("approve")}
          className="rounded-md bg-emerald-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          data-testid="hitl-diff-tweak"
          disabled={locked || busy}
          onClick={() => void decide("tweak")}
          className="rounded-md border border-stone-400 bg-white px-3 py-1 text-xs font-semibold text-stone-800 disabled:opacity-50"
        >
          Ask to tweak
        </button>
        <button
          type="button"
          data-testid="hitl-diff-discard"
          disabled={locked || busy}
          onClick={() => void decide("discard")}
          className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700 disabled:opacity-50"
        >
          Discard
        </button>
      </div>
      <CancelLink m={m} locked={locked} />
    </div>
  );
}

function DiffPane({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-2">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
        {label}
      </p>
      <pre
        className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px]"
        data-testid={`diff-${label.toLowerCase()}`}
      >
        {renderValue(value)}
      </pre>
    </div>
  );
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

function ApprovalBody({ m, locked }: { m: DockMessage; locked: boolean }) {
  const payload = m.hitlApproval;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!payload) return null;

  const decide = async (decision: "approve" | "reject") => {
    if (!m.resumeToken || busy) return;
    setBusy(true);
    const value: Record<string, unknown> = {
      decision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    try {
      await respondToHitl(
        m.id,
        m.resumeToken,
        value,
        decision === "approve"
          ? `Approved${reason.trim() ? ` — ${reason.trim()}` : ""}`
          : `Rejected${reason.trim() ? ` — ${reason.trim()}` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="mb-2 text-stone-800">
        Vantage wants to <strong>{payload.action}</strong>.
      </p>
      {payload.payload !== undefined && payload.payload !== null && (
        <pre
          className="mb-3 max-h-32 overflow-auto rounded-md border border-stone-200 bg-white p-2 text-[11px]"
          data-testid="hitl-approval-payload"
        >
          {renderValue(payload.payload)}
        </pre>
      )}
      <input
        data-testid="hitl-approval-reason"
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={locked || busy}
        placeholder="Optional note for the agent…"
        className="mb-3 w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm disabled:opacity-50"
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="hitl-approval-approve"
          disabled={locked || busy}
          onClick={() => void decide("approve")}
          className="rounded-md bg-emerald-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          data-testid="hitl-approval-reject"
          disabled={locked || busy}
          onClick={() => void decide("reject")}
          className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      <CancelLink m={m} locked={locked} />
    </div>
  );
}

function CancelLink({ m, locked }: { m: DockMessage; locked: boolean }) {
  if (locked) return null;
  return (
    <button
      type="button"
      data-testid="hitl-cancel"
      onClick={() => cancelHitl(m.id)}
      className="mt-3 text-[11px] text-stone-500 underline-offset-2 hover:underline"
    >
      Cancel without answering
    </button>
  );
}
