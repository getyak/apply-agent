"use client";

// /app/studio/resume — Résumé view (document + version timeline).
//
// Earlier this route flipped store.screen → "builder" to overlay the
// chat-driven builder. The Vantage redesign moves the chat into the
// persistent Ask Vantage dock, leaving this route to host the document
// face only — see docs/architecture/vantage-ui-mapping.md §2.
// All résumé edits funnel through Ask Vantage now.

import { useEffect } from "react";
import { useVantage } from "@/lib/store";
import { ResumeView } from "@/components/screens/resume-view";

export default function ResumeStudioPage() {
  const setScreen = useVantage((s) => s.setScreen);

  // The legacy goBuilder() call would flip screen → "builder", taking
  // us into the chat builder overlay. The Vantage design moves the
  // builder into the dock, so we explicitly hold screen on "app" here
  // (resetting from any prior overlay) and render the document face.
  useEffect(() => {
    setScreen("app");
  }, [setScreen]);

  return <ResumeView />;
}
