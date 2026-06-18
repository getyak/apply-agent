"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useVantage } from "@/lib/store";

// /app is a router: the layout handles auth + onboarding + overlays; we just
// pick the right home tab and redirect.
//   - returning user (resumeWorkspace in layout sets screen="app", nav="today")
//     → /app/today (lands them on the briefing, the highest-signal screen)
//   - brand-new / no résumé (screen still "onboarding") → render nothing, the
//     layout already shows OnboardingScreen
export default function AppRedirectPage() {
  const router = useRouter();
  const screen = useVantage((s) => s.screen);

  useEffect(() => {
    if (screen === "app") {
      router.replace("/app/today");
    }
  }, [router, screen]);

  return null;
}
