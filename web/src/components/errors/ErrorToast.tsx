"use client";

// Toast surface — bottom-right pinned, dismissable, with a Reference
// strip. We DON'T use sonner / react-hot-toast: zero new dependencies
// for a feature this small. The container subscribes to a tiny event
// emitter (resolveError → emitErrorToast(resolved)) so any code path
// can push without prop-drilling.

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { ResolvedError, Cta } from "@/lib/errors/resolve";
import { emitTelemetry, currentPath } from "@/lib/telemetry";
import { ErrorDetails } from "./ErrorDetails";

// ───────── tiny event bus ─────────
type ToastItem = {
  id: number;
  resolved: ResolvedError;
  onCta?: (cta: Cta) => void;
  ttlMs: number;
};

type Listener = (item: ToastItem) => void;
const listeners = new Set<Listener>();
let seq = 1;

export function emitErrorToast(
  resolved: ResolvedError,
  opts?: { onCta?: (cta: Cta) => void; ttlMs?: number },
) {
  if (resolved.surface === "silent") return;
  const item: ToastItem = {
    id: seq++,
    resolved,
    onCta: opts?.onCta,
    // Errors stick longer than success toasts — users may need to read
    // the Reference. Severity "error" → 12s; warning → 8s.
    ttlMs:
      opts?.ttlMs ??
      (resolved.severity === "error" || resolved.severity === "critical"
        ? 12000
        : 8000),
  };
  listeners.forEach((l) => l(item));
}

// ───────── container ─────────
export function ErrorToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onAdd: Listener = (item) => {
      setItems((prev) => [...prev, item]);
      // Auto-dismiss after ttl.
      window.setTimeout(() => {
        setItems((prev) => prev.filter((p) => p.id !== item.id));
      }, item.ttlMs);
    };
    listeners.add(onAdd);
    return () => {
      listeners.delete(onAdd);
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="fixed z-[60] bottom-4 right-4 max-w-[380px] flex flex-col gap-2"
      aria-live="polite"
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: () => void;
}) {
  const t = useTranslations();
  const { resolved } = item;
  // One emission per toast pushed.
  useEffect(() => {
    emitTelemetry({
      name: "error_shown",
      payload: {
        code: resolved.copyable.code,
        surface: "toast",
        traceId: resolved.copyable.traceId,
        traceCode: resolved.traceCode,
        severity: resolved.severity,
        path: currentPath(),
      },
    });
    // we want exactly one emission per ToastItem, keyed on its stable id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
  const accent =
    resolved.severity === "error" || resolved.severity === "critical"
      ? "border-l-amber"
      : resolved.severity === "warning"
        ? "border-l-amber"
        : "border-l-brown";

  return (
    <div
      role="status"
      className={`relative bg-white border border-cream-border ${accent} border-l-[3px] rounded-[12px] shadow-md px-4 py-3 animate-fade-up`}
    >
      <button
        type="button"
        aria-label={t("errors._common.dismiss")}
        onClick={onDismiss}
        className="absolute top-2 right-2 text-ink-muted hover:text-ink p-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brown"
      >
        ×
      </button>
      <div className="font-body text-[14px] font-semibold text-ink pr-5">
        {t(resolved.titleKey, resolved.bodyVars)}
      </div>
      <div className="mt-0.5 font-body text-[13px] text-ink-light">
        {t(resolved.bodyKey, resolved.bodyVars)}
      </div>
      {resolved.ctas.length > 0 && (
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          {resolved.ctas.map((cta) => (
            <button
              key={cta.id}
              type="button"
              onClick={() => {
                item.onCta?.(cta);
                if (cta.id === "dismiss") onDismiss();
              }}
              className="text-brown font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brown rounded text-[12px]"
            >
              {t(cta.labelKey)}
            </button>
          ))}
        </div>
      )}
      <ErrorDetails copyable={resolved.copyable} compact />
    </div>
  );
}
