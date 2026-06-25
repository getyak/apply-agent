"use client";

// Public résumé read-only view (the body of /r/[token]).
//
// Loads /api/public/r/:token through the no-auth `publicResume` client,
// renders the canonical Markdown with the same .resume-prose theme used in
// /app/resume/[id] and the PDF export. On 404 (token not found, revoked, or
// shape-rejected) we show a deliberately generic "not available" page —
// never reveal which of the three reasons caused the miss (prevents
// enumeration of valid/invalid tokens).
//
// No dock. No sidebar. No login affordance. The footer's only link is
// "Made with Vantage" → marketing surface, never the auth gate.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { publicResume, ApiError } from "@/lib/api";
import { ResumeMarkdown } from "@/components/studio/resume-markdown";

interface ViewProps {
  token: string;
}

interface LoadedPublic {
  basics: { name: string | null; label: string | null };
  markdown: string;
  publishedAt: string;
}

export function ResumePublicView({ token }: ViewProps) {
  const t = useTranslations("resume.public");
  const [resume, setResume] = useState<LoadedPublic | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    publicResume
      .fetch(token)
      .then((res) => {
        if (cancelled) return;
        setResume({
          basics: res.basics,
          markdown: res.markdown,
          publishedAt: res.publishedAt,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // We never differentiate 404 from other errors here. Anything that
        // isn't a successful render → generic not-available page.
        void err;
        setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (notFound) {
    return (
      <div style={pageStyle}>
        <main style={notFoundShellStyle}>
          <h1 style={notFoundTitleStyle}>{t("notFound.title")}</h1>
          <p style={notFoundBodyStyle}>{t("notFound.body")}</p>
          <Footer t={t} />
        </main>
      </div>
    );
  }

  if (!resume) {
    return (
      <div style={pageStyle}>
        <main style={loadingShellStyle}>
          <p style={loadingStyle}>{t("loading")}</p>
        </main>
      </div>
    );
  }

  const publishedDate = new Date(resume.publishedAt).toLocaleDateString();

  return (
    <div style={pageStyle}>
      <main style={publicShellStyle}>
        <article style={paperStyle}>
          <ResumeMarkdown markdown={resume.markdown} showAIOverlay={false} />
        </article>
        <p style={publishedOnStyle}>
          {t("publishedOn", { date: publishedDate })}
        </p>
        <Footer t={t} />
      </main>
    </div>
  );
}

function Footer({
  t,
}: {
  t: ReturnType<typeof useTranslations<"resume.public">>;
}) {
  return (
    <footer style={footerStyle}>
      <Link href="/" style={footerLinkStyle}>
        {t("madeWith")}
      </Link>
    </footer>
  );
}

// ─── Inline style tokens ─────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#FAF8F6",
  padding: "32px 16px 64px",
  display: "flex",
  justifyContent: "center",
};
const publicShellStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 820,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
};
const notFoundShellStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 520,
  alignSelf: "center",
  padding: "120px 24px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 18,
  textAlign: "center",
};
const loadingShellStyle: React.CSSProperties = {
  width: "100%",
  textAlign: "center",
  padding: "120px 24px",
};
const paperStyle: React.CSSProperties = {
  width: "100%",
  background: "#fff",
  borderRadius: 6,
  padding: "56px 64px",
  boxShadow: "0 4px 24px rgba(40, 35, 28, 0.06)",
  border: "1px solid #E8DCCA",
};
const notFoundTitleStyle: React.CSSProperties = {
  fontFamily: "Space Grotesk, sans-serif",
  fontWeight: 700,
  fontSize: 24,
  color: "#2B2822",
  margin: 0,
};
const notFoundBodyStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 14,
  color: "#6B6560",
  margin: 0,
};
const publishedOnStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 11,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#8A8278",
  margin: "8px 0 0",
};
const loadingStyle: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 12,
  letterSpacing: "0.18em",
  color: "#8A8278",
};
const footerStyle: React.CSSProperties = {
  marginTop: 32,
};
const footerLinkStyle: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 12,
  color: "#8A8278",
  textDecoration: "none",
};
