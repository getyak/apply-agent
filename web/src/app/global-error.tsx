"use client";

// App-level error boundary. Fires only when the root layout itself
// crashes (rare — but a broken i18n provider, broken font load, or
// thrown server-side fetch in layout will trigger it). We CANNOT
// rely on next-intl here because the provider lives inside the root
// layout that just failed — so the copy is hard-coded EN, kept
// minimal, and deliberately ASCII so any font fallback renders.

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry?: () => void;
}) {
  useEffect(() => {
    // Keep this lean — global-error.tsx runs when the world is on
    // fire. Don't await fetches, don't render rich UI.
    // eslint-disable-next-line no-console
    console.error("[global-error]", error);
  }, [error]);

  const reference = error?.digest ?? "";

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          background: "#FAF7F2",
          color: "#222",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px",
        }}
      >
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <div
            style={{
              fontWeight: 700,
              letterSpacing: 3,
              fontSize: 14,
              color: "#7B5B3B",
              marginBottom: 16,
            }}
          >
            VANTAGE
          </div>
          <h1 style={{ fontSize: 26, lineHeight: 1.2, margin: "0 0 12px" }}>
            Something went seriously wrong
          </h1>
          <p style={{ fontSize: 15, color: "#555", margin: "0 0 24px" }}>
            We couldn&apos;t render the app shell. Try reloading. If that
            doesn&apos;t fix it, please copy the reference below and reach
            out.
          </p>
          <button
            onClick={() => (unstable_retry ? unstable_retry() : reset())}
            style={{
              background: "#222",
              color: "#fff",
              border: 0,
              borderRadius: 8,
              padding: "10px 20px",
              fontSize: 14,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Reload
          </button>
          {reference && (
            <div
              style={{
                marginTop: 24,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                color: "#888",
              }}
            >
              Reference: <span style={{ color: "#222" }}>{reference}</span>
            </div>
          )}
        </div>
      </body>
    </html>
  );
}
