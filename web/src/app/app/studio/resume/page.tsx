"use client";

import { useEffect } from "react";
import { useVantage } from "@/lib/store";

// Studio entries are routed so the URL is shareable and refresh-safe, but the
// builder UI is a full-takeover overlay driven by store.screen — this page just
// flips the store on mount and renders nothing (the layout shows BuilderScreen).
export default function ResumeStudioPage() {
  const goBuilder = useVantage((s) => s.goBuilder);

  useEffect(() => {
    goBuilder();
  }, [goBuilder]);

  return null;
}
