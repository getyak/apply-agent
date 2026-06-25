// /r/[token] — public read-only résumé delivery.
//
// Layout posture: no dock, no sidebar, no chrome. The only "navigation" is
// the watermark linking back to vantage.dev — this is the page a recruiter
// opens from an email. Robots are blocked at the metadata layer below
// (next/docs/01-app/03-api-reference/04-functions/generate-metadata.md
// "robots"): recruiters share links by URL, search engines should never
// index a private résumé.
//
// Server Component so we can export `metadata`. The actual fetch happens
// in the Client child — see ./view.tsx.

import type { Metadata } from "next";
import { ResumePublicView } from "./view";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function PublicResumePage({ params }: PageProps) {
  const { token } = await params;
  return <ResumePublicView token={token} />;
}
