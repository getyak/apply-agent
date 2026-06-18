"use client";

import { useEffect } from "react";
import { useVantage } from "@/lib/store";

// Same pattern as resume studio: route exists so the URL is shareable, the UI
// itself is a full-takeover MockScreen driven by store.screen.
export default function MockStudioPage() {
  const goMockSetup = useVantage((s) => s.goMockSetup);

  useEffect(() => {
    goMockSetup();
  }, [goMockSetup]);

  return null;
}
