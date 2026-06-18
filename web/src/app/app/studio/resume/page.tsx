"use client";

// /app/studio/resume — Résumé view (vibe chat + document + version timeline).
//
// Per vantage-ui-mapping.md §2 (rev. 2026-06-18): Resume Studio carries its
// own document-scoped vibe chat on the left and the live document + timeline
// on the right. The Ask Vantage dock still exists as the cross-surface
// lifetime conversation — see §2.6 for the channel split.

import { useEffect } from "react";
import { useVantage } from "@/lib/store";
import { ResumeView } from "@/components/screens/resume-view";

export default function ResumeStudioPage() {
  const setScreen = useVantage((s) => s.setScreen);

  // Reset from any prior overlay (legacy "builder" screen) and render
  // the studio. ResumeView owns its own layout — chat panel + document.
  useEffect(() => {
    setScreen("app");
  }, [setScreen]);

  return <ResumeView />;
}
