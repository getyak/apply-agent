import type { MetadataRoute } from "next";
import { SITE_NAME } from "@/lib/site";

// PWA manifest — keeps Lighthouse "Installable" + "PWA" categories happy and
// lets iOS/Android add Vantage to the home screen with the right chrome.
// theme_color matches the light-mode value in layout.tsx's viewport export so
// the splash screen and address bar stay on-brand from cold boot.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — Your job hunt, run by agents`,
    short_name: SITE_NAME,
    description:
      "Drop your résumé in. AI agents find the right roles, tailor every application, draft your answers, and prep your interviews — you review and hit submit.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FAF8F6",
    theme_color: "#FAF8F6",
    categories: ["productivity", "business", "education"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
