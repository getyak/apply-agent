// Single source of truth for site-level metadata used by SEO, OG, JSON-LD,
// sitemap, robots, and PWA manifest. Read once at build time from
// NEXT_PUBLIC_SITE_URL (falls back to the production guess), so the same value
// flows into every absolute-URL surface without manual duplication.

const RAW =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
  "https://vantage.app";

// Strip any trailing slash so callers can write `${SITE_URL}/foo` safely.
export const SITE_URL = RAW.replace(/\/+$/, "");

export const SITE_NAME = "Vantage";
export const SITE_TAGLINE = "Your job hunt, run by agents";

// Twitter handle for twitter:site / twitter:creator. Defaults to the brand
// account so cards always credit Vantage; env override exists for future
// renames or per-deploy variants. Always begins with "@" — normalised below.
function normaliseHandle(raw: string): string {
  const trimmed = raw.trim().replace(/^@+/, "");
  return trimmed ? `@${trimmed}` : "";
}
export const TWITTER_HANDLE = normaliseHandle(
  process.env.NEXT_PUBLIC_TWITTER_HANDLE || "vantage_app",
);

// Public social/community footprint exposed via Organization.sameAs JSON-LD.
// Listing the GitHub repo here lets Google's Knowledge Graph link the org to
// our public source-of-truth (the very point of `sameAs` per schema.org). The
// list is intentionally narrow — `sameAs` should only contain pages that are
// uniquely about Vantage, not generic profiles. Add new URLs as the brand
// expands; env override lets staging point at a sandbox tenant.
const DEFAULT_SOCIAL_LINKS = [
  "https://github.com/getyak/apply-agent",
  `https://twitter.com/${TWITTER_HANDLE.replace(/^@/, "")}`,
];
export const SOCIAL_LINKS: string[] = (
  process.env.NEXT_PUBLIC_SOCIAL_LINKS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? DEFAULT_SOCIAL_LINKS
);

// Locales we ship copy for; used to emit <link rel="alternate" hreflang="…">
// and sitemap entries. Kept here (not imported from i18n/config) so the SEO
// layer stays decoupled from runtime locale resolution.
export const LOCALES = ["en", "zh"] as const;
export type SeoLocale = (typeof LOCALES)[number];

// BCP-47 mapping for OpenGraph / hreflang. zh → zh-CN is the safest default
// for search engines; we'll add zh-Hant only when we actually ship Traditional
// copy.
export const HREFLANG: Record<SeoLocale, string> = {
  en: "en",
  zh: "zh-CN",
};

export const OG_LOCALE: Record<SeoLocale, string> = {
  en: "en_US",
  zh: "zh_CN",
};
