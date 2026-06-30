import type { MetadataRoute } from "next";
import { HREFLANG, LOCALES, SITE_URL, type SeoLocale } from "@/lib/site";

// Cookie-based locale strategy means every public route has a single URL —
// alternates surface the localized variants for the same URL via hreflang.
// Build the languages map once per entry instead of duplicating per locale.
function alternates(path: string): Record<string, string> {
  const url = `${SITE_URL}${path}`;
  const out: Record<string, string> = { "x-default": url };
  for (const l of LOCALES as readonly SeoLocale[]) {
    out[HREFLANG[l]] = url;
  }
  return out;
}

// Public, indexable surfaces. Anything under /app/* is gated by auth and stays
// out of search; the redirect-on-no-token middleware would 302 crawlers to /
// anyway, but blocking explicitly in robots.txt avoids wasted crawl budget.
const ROUTES: Array<{
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
}> = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/auth", changeFrequency: "monthly", priority: 0.5 },
  { path: "/legal/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/legal/security", changeFrequency: "yearly", priority: 0.3 },
  { path: "/legal/docs", changeFrequency: "monthly", priority: 0.4 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  // Static `new Date()` at build time is fine — lastModified being approximate
  // is the standard sitemap behaviour for marketing pages, and ISO-8601 here
  // satisfies sitemaps.org schema validators.
  const now = new Date();
  return ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
    alternates: { languages: alternates(path) },
  }));
}
