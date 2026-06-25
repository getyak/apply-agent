"use client";

// /app/resume/[id] — Résumé delivery page.
//
// This is the "what can I do with this version" surface, distinct from
// /app/studio/resume which owns editing. Layout: a thin top toolbar over
// a centered A4 column of the résumé rendered with the same .resume-prose
// theme used in print and PDF export. Every outgoing action lives behind the
// "Operations" button → right-rail drawer.
//
// Next.js 15 contract: params is a Promise; use() unwraps it inside a Client
// Component (per next/docs/01-app/03-api-reference/03-file-conventions/
// dynamic-routes.md "In Client Components").

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { resumes as resumesApi, ApiError } from "@/lib/api";
import { useDock } from "@/lib/ask-vantage-store";
import { ResumeMarkdown } from "@/components/studio/resume-markdown";
import { OperationsDrawer } from "@/components/resume/operations-drawer";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface LoadedResume {
  id: string;
  markdown: string;
  version: number;
  track: "original" | "optimized" | "tailored" | undefined;
  publishToken: string | null;
  publishedAt: string | null;
}

export default function ResumeDeliveryPage({ params }: PageProps) {
  const { id } = use(params);
  const t = useTranslations("resume.delivery");
  const router = useRouter();

  const [resume, setResume] = useState<LoadedResume | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Delivery is a focused, document-first surface — collapse the dock to
  // its launcher pill (same posture as mock-live) so the résumé page reads
  // like a print preview, not a chat surrounded by chrome. Reset on unmount
  // so navigating back to studio restores the user's prior dock state.
  useEffect(() => {
    const dock = useDock.getState();
    dock.setHintedCollapse(true);
    return () => {
      useDock.getState().setHintedCollapse(false);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    resumesApi
      .get(id)
      .then((res) => {
        if (cancelled) return;
        const md =
          typeof res.resume.content._markdown === "string"
            ? res.resume.content._markdown
            : "";
        setResume({
          id: res.resume.id,
          markdown: md,
          version: res.resume.version,
          track: res.resume.track,
          publishToken: res.resume.publish_token ?? null,
          publishedAt: res.resume.published_at ?? null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // The user followed a stale URL or doesn't own the résumé. Send
          // them back to the studio rather than a dead end.
          router.replace("/app/studio/resume");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  if (error) {
    return (
      <div style={pageStyle}>
        <p style={errorStyle}>{error}</p>
      </div>
    );
  }

  if (!resume) {
    return (
      <div style={pageStyle}>
        <p style={loadingStyle}>{t("loading")}</p>
      </div>
    );
  }

  const versionLabel = `v${resume.version}`;
  const trackBadge = resume.track ? resume.track.toUpperCase() : "";

  return (
    <div style={pageStyle}>
      <header style={toolbarStyle}>
        <div style={toolbarLeftStyle}>
          <button
            onClick={() => router.back()}
            style={ghostBtnStyle}
            aria-label={t("back")}
          >
            ← {t("back")}
          </button>
          <div style={toolbarTitleStyle}>
            <span style={toolbarVersionStyle}>{versionLabel}</span>
            {trackBadge && <span style={toolbarTrackStyle}>{trackBadge}</span>}
            {resume.publishToken ? (
              <span style={publishedBadgeStyle}>{t("publishedBadge")}</span>
            ) : (
              <span style={draftBadgeStyle}>{t("notPublishedBadge")}</span>
            )}
          </div>
        </div>
        <div style={toolbarRightStyle}>
          <Link href="/app/studio/resume" style={ghostBtnStyle}>
            {t("open")}
          </Link>
          <button
            onClick={() => setDrawerOpen(true)}
            style={primaryToolbarBtnStyle}
            aria-label={t("openOps")}
          >
            {t("operations")} ↦
          </button>
        </div>
      </header>

      <main style={pageBodyStyle}>
        <article style={paperStyle}>
          <ResumeMarkdown markdown={resume.markdown} showAIOverlay={false} />
        </article>
      </main>

      <OperationsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        resumeId={resume.id}
        versionLabel={versionLabel}
        initialPublishToken={resume.publishToken}
        initialPublishedAt={resume.publishedAt}
      />
    </div>
  );
}

// ─── Inline style tokens ─────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "100vh",
  background: "#FAF8F6",
};
const toolbarStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 10,
  background: "#FBFAF7",
  borderBottom: "1px solid #E8DCCA",
  padding: "12px 24px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 16,
};
const toolbarLeftStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};
const toolbarRightStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};
const toolbarTitleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};
const toolbarVersionStyle: React.CSSProperties = {
  fontFamily: "Space Grotesk, sans-serif",
  fontWeight: 700,
  fontSize: 18,
  color: "#2B2822",
  letterSpacing: "-0.3px",
};
const toolbarTrackStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 10,
  letterSpacing: "0.16em",
  color: "#5D3000",
  padding: "2px 8px",
  background: "#F5ECD9",
  borderRadius: 4,
};
const publishedBadgeStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 10,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "#2A5F2A",
  background: "#E5F2E5",
  padding: "2px 8px",
  borderRadius: 4,
};
const draftBadgeStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 10,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "#8A8278",
  background: "transparent",
  border: "1px solid #E8DCCA",
  padding: "2px 8px",
  borderRadius: 4,
};
const ghostBtnStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontWeight: 500,
  fontSize: 13,
  padding: "7px 12px",
  borderRadius: 8,
  border: "1px solid #E8DCCA",
  background: "transparent",
  color: "#2B2822",
  cursor: "pointer",
  textDecoration: "none",
};
const primaryToolbarBtnStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontWeight: 600,
  fontSize: 13,
  padding: "7px 14px",
  borderRadius: 8,
  border: "1px solid #2B2822",
  background: "#2B2822",
  color: "#FBFAF7",
  cursor: "pointer",
};
const pageBodyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  justifyContent: "center",
  padding: "32px 24px 64px",
};
const paperStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 800,
  background: "#fff",
  borderRadius: 6,
  padding: "56px 64px",
  boxShadow: "0 4px 24px rgba(40, 35, 28, 0.06)",
  border: "1px solid #E8DCCA",
};
const loadingStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "120px 24px",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 12,
  letterSpacing: "0.18em",
  color: "#8A8278",
};
const errorStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "120px 24px",
  fontFamily: "Inter, sans-serif",
  color: "#8B3A1F",
};
