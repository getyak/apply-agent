"use client";

/**
 * browser-card.tsx — a browser session (relay.browser_snapshot /
 * browser_action). Collapsed by default: latest url + a tiny thumbnail.
 * Expanding loads the full screenshot + the action log (plan constraint #6:
 * the heavy full screenshot is only rendered once expanded).
 *
 * Caller: step-card.tsx (kind === "browser").
 * Facts: no data-file IO; reads step.browser.{snapshots,actions}. Screenshot
 * URLs come from agents (MinIO) — rendered as <img>, never fetched here.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Step } from "@/lib/agent-events";
import { CardFrame, statusColor } from "../step-card";

export function BrowserCard({ step }: { step: Step }) {
  const t = useTranslations("dock");
  const [open, setOpen] = useState(false);
  const browser = step.browser;
  if (!browser) return null;

  const snapshots = browser.snapshots;
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  return (
    <CardFrame testId="step-browser" surface={false}>
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #EDE8DF",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="step-browser-toggle"
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              width: 12,
              color: "#A39F99",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform .12s ease-out",
            }}
          >
            ▶
          </span>
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: statusColor(step.status),
              flexShrink: 0,
            }}
          />
          <span
            className="ds-mono-10"
            style={{ color: "#5D3000", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {latest?.url || t("browser.label")}
          </span>
          {/* Collapsed thumbnail — small, decorative, low-cost. */}
          {!open && latest?.screenshotUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={latest.screenshotUrl}
              alt=""
              aria-hidden
              style={{
                width: 36,
                height: 24,
                objectFit: "cover",
                borderRadius: 4,
                border: "1px solid #EDE8DF",
                flexShrink: 0,
              }}
            />
          ) : null}
          <span className="ds-mono-9" style={{ color: "#A39F99", flexShrink: 0 }}>
            {t("browser.snapshotCount", { count: snapshots.length })}
          </span>
        </button>
        {open ? (
          <div
            style={{
              borderTop: "1px solid #F0E8DA",
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              background: "#FBF8F3",
            }}
          >
            {latest?.screenshotUrl ? (
              // Full screenshot only rendered once expanded (constraint #6).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={latest.screenshotUrl}
                alt={t("browser.screenshotAlt", { url: latest.url })}
                data-testid="step-browser-screenshot"
                style={{
                  width: "100%",
                  borderRadius: 8,
                  border: "1px solid #EDE8DF",
                }}
              />
            ) : null}
            {browser.actions.length > 0 ? (
              <ul
                data-testid="step-browser-actions"
                style={{
                  margin: 0,
                  padding: "0 0 0 16px",
                  fontFamily: "JetBrains Mono, ui-monospace, monospace",
                  fontSize: 11,
                  color: "#5D5046",
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
              >
                {browser.actions.map((a, idx) => (
                  <li key={idx}>
                    {a.action} · {a.target}
                    {a.value ? ` = ${a.value}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </CardFrame>
  );
}
