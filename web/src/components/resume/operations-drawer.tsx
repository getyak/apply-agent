"use client";

// Résumé operations drawer — the right-rail "what can I do with this version"
// panel for /app/resume/[id]. Groups every outgoing action a user has on a
// single résumé version:
//
//   · Export (md / pdf / docx / json)
//   · Share (publish read-only link · revoke)
//   · Print (window.print)
//
// Why a drawer (not header buttons): three actions × four formats fits
// awkwardly across a header. A vertical panel also gives Share enough room
// to surface the generated URL with copy/revoke affordances without inventing
// a popover.
//
// All copy goes through next-intl. Token UI is local state — there's no
// per-user "my published résumés" store yet, and the API call is fast enough
// that re-publishing on demand is fine.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { resumes as resumesApi, ApiError } from "@/lib/api";

type ExportFormat = "md" | "pdf" | "docx" | "json";

interface OperationsDrawerProps {
  open: boolean;
  onClose: () => void;
  resumeId: string;
  /** "v7" / "Master" / etc — purely for the panel header. */
  versionLabel: string;
  /** When already published, parent passes the token+timestamp so we render
   *  the live URL on first open instead of an empty Publish CTA. */
  initialPublishToken?: string | null;
  initialPublishedAt?: string | null;
}

export function OperationsDrawer({
  open,
  onClose,
  resumeId,
  versionLabel,
  initialPublishToken,
  initialPublishedAt,
}: OperationsDrawerProps) {
  const t = useTranslations("resume.operations");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [publishToken, setPublishToken] = useState<string | null>(
    initialPublishToken ?? null,
  );
  const [publishedAt, setPublishedAt] = useState<string | null>(
    initialPublishedAt ?? null,
  );
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ESC closes the drawer. Bound only while open so we don't trap focus
  // when the panel is hidden behind 0-width.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  async function handleExport(format: ExportFormat) {
    setExporting(format);
    setExportError(null);
    try {
      await resumesApi.download(resumeId, format);
    } catch (err) {
      // 501 = "PDF/DOCX requires a server upgrade" — the API's friendly copy
      // already says "try Markdown or PDF", so surface it verbatim. Other
      // failures collapse to a generic message.
      const msg =
        err instanceof ApiError && err.message
          ? err.message
          : t("exportFailed");
      setExportError(msg);
    } finally {
      setExporting(null);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await resumesApi.publish(resumeId);
      setPublishToken(res.publishToken);
      setPublishedAt(res.publishedAt);
    } catch (err) {
      setPublishError(
        err instanceof ApiError && err.message
          ? err.message
          : t("publishFailed"),
      );
    } finally {
      setPublishing(false);
    }
  }

  async function handleRevoke() {
    setPublishing(true);
    setPublishError(null);
    try {
      await resumesApi.revokePublish(resumeId);
      setPublishToken(null);
      setPublishedAt(null);
    } catch (err) {
      setPublishError(
        err instanceof ApiError && err.message
          ? err.message
          : t("revokeFailed"),
      );
    } finally {
      setPublishing(false);
    }
  }

  async function handleCopy() {
    if (!publishToken) return;
    const url = `${window.location.origin}/r/${publishToken}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard permission — leave URL selectable inline so the user can
      // copy manually.
      setCopied(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  if (!open) return null;

  return (
    <>
      {/* Click-outside scrim. Clicks inside the panel stop propagation. */}
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(40, 35, 28, 0.18)",
          zIndex: 40,
        }}
      />
      <aside
        role="dialog"
        aria-label={t("title")}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 360,
          maxWidth: "100vw",
          background: "#FBFAF7",
          borderLeft: "1px solid #E8DCCA",
          boxShadow: "-12px 0 32px rgba(40, 35, 28, 0.08)",
          padding: "20px 22px",
          overflowY: "auto",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <div>
            <div style={drawerEyebrowStyle}>{t("eyebrow")}</div>
            <div style={drawerTitleStyle}>{versionLabel}</div>
          </div>
          <button
            onClick={onClose}
            aria-label={t("close")}
            style={iconBtnStyle}
          >
            ×
          </button>
        </header>

        <Section title={t("export.title")}>
          <ExportRow
            label={t("export.markdown")}
            sub={t("export.markdownSub")}
            busy={exporting === "md"}
            onClick={() => handleExport("md")}
          />
          <ExportRow
            label={t("export.pdf")}
            sub={t("export.pdfSub")}
            busy={exporting === "pdf"}
            onClick={() => handleExport("pdf")}
          />
          <ExportRow
            label={t("export.docx")}
            sub={t("export.docxSub")}
            tag={t("export.beta")}
            busy={exporting === "docx"}
            onClick={() => handleExport("docx")}
          />
          <ExportRow
            label={t("export.json")}
            sub={t("export.jsonSub")}
            busy={exporting === "json"}
            onClick={() => handleExport("json")}
          />
          {exportError && <p style={errorStyle}>{exportError}</p>}
        </Section>

        <Section title={t("share.title")}>
          {publishToken ? (
            <>
              <p style={subtleStyle}>
                {t("share.published")}
                {publishedAt
                  ? ` · ${new Date(publishedAt).toLocaleString()}`
                  : ""}
              </p>
              <div style={urlBoxStyle}>
                <span style={urlTextStyle}>
                  {typeof window !== "undefined"
                    ? `${window.location.origin}/r/${publishToken}`
                    : `/r/${publishToken}`}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleCopy}
                  disabled={publishing}
                  style={primaryBtnStyle}
                >
                  {copied ? t("share.copied") : t("share.copy")}
                </button>
                <button
                  onClick={handleRevoke}
                  disabled={publishing}
                  style={dangerBtnStyle}
                >
                  {t("share.revoke")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={subtleStyle}>{t("share.notPublishedBody")}</p>
              <button
                onClick={handlePublish}
                disabled={publishing}
                style={primaryBtnStyle}
              >
                {publishing ? t("share.publishing") : t("share.publish")}
              </button>
            </>
          )}
          {publishError && <p style={errorStyle}>{publishError}</p>}
        </Section>

        <Section title={t("print.title")}>
          <button onClick={handlePrint} style={secondaryBtnStyle}>
            {t("print.cta")}
          </button>
        </Section>
      </aside>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={sectionHeaderStyle}>{title}</h3>
      {children}
    </section>
  );
}

function ExportRow({
  label,
  sub,
  busy,
  tag,
  onClick,
}: {
  label: string;
  sub: string;
  busy?: boolean;
  tag?: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={busy} style={exportRowStyle}>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={exportLabelStyle}>{label}</span>
          {tag ? <span style={tagStyle}>{tag}</span> : null}
        </span>
        <span style={exportSubStyle}>{sub}</span>
      </span>
      <span style={exportCtaStyle}>{busy ? "…" : "↓"}</span>
    </button>
  );
}

// ─── Inline style tokens ─────────────────────────────────────────────────

const drawerEyebrowStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 10,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "#8A8278",
};
const drawerTitleStyle: React.CSSProperties = {
  fontFamily: "Space Grotesk, sans-serif",
  fontWeight: 700,
  fontSize: 22,
  lineHeight: 1.1,
  color: "#2B2822",
};
const sectionHeaderStyle: React.CSSProperties = {
  fontFamily: "Space Grotesk, sans-serif",
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "#5D3000",
  margin: 0,
};
const subtleStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 13,
  lineHeight: 1.55,
  color: "#6B6560",
  margin: 0,
};
const errorStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 12,
  color: "#8B3A1F",
  margin: 0,
};
const iconBtnStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  fontSize: 24,
  lineHeight: 1,
  color: "#8A8278",
  cursor: "pointer",
};
const exportRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  border: "1px solid #E8DCCA",
  background: "#fff",
  borderRadius: 10,
  padding: "10px 12px",
  cursor: "pointer",
  textAlign: "left",
};
const exportLabelStyle: React.CSSProperties = {
  fontFamily: "Space Grotesk, sans-serif",
  fontWeight: 600,
  fontSize: 14,
  color: "#2B2822",
};
const exportSubStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 12,
  color: "#8A8278",
};
const exportCtaStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 14,
  color: "#5D3000",
};
const tagStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 9,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#5D3000",
  background: "#F5ECD9",
  padding: "2px 6px",
  borderRadius: 4,
};
const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: "Inter, sans-serif",
  fontWeight: 600,
  fontSize: 13,
  padding: "9px 14px",
  borderRadius: 8,
  border: "1px solid #2B2822",
  background: "#2B2822",
  color: "#FBFAF7",
  cursor: "pointer",
};
const secondaryBtnStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontWeight: 600,
  fontSize: 13,
  padding: "9px 14px",
  borderRadius: 8,
  border: "1px solid #C9A368",
  background: "#fff",
  color: "#2B2822",
  cursor: "pointer",
  alignSelf: "flex-start",
};
const dangerBtnStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: "Inter, sans-serif",
  fontWeight: 600,
  fontSize: 13,
  padding: "9px 14px",
  borderRadius: 8,
  border: "1px solid #C9A368",
  background: "#fff",
  color: "#8B3A1F",
  cursor: "pointer",
};
const urlBoxStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "#fff",
  border: "1px solid #E8DCCA",
  borderRadius: 8,
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 11,
  color: "#2B2822",
  wordBreak: "break-all",
};
const urlTextStyle: React.CSSProperties = {
  userSelect: "all",
};
