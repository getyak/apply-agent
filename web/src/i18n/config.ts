// i18n configuration — single source of truth for supported locales.
//
// Relay uses a no-prefix locale strategy (next-intl): the URL never changes
// (/app/today stays /app/today regardless of language). The active locale is
// stored in the `NEXT_LOCALE` cookie (read server-side by i18n/request.ts) and
// mirrored to localStorage for instant client-side switching without a flash.

export const LOCALES = ["en", "zh"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Cookie name read by next-intl's getRequestConfig on the server. Kept in sync
// with the language switcher that writes it on the client.
export const LOCALE_COOKIE = "NEXT_LOCALE";

// localStorage key — client-side mirror so the switcher can apply the new
// language optimistically before the server round-trip completes.
export const LOCALE_STORAGE_KEY = "vantage_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

// Map an arbitrary BCP-47 language tag (e.g. "zh-CN", "en-US", "zh-Hant") to a
// supported locale. Anything Chinese → zh; everything else → en (our source
// language). Used for first-visit detection from navigator.language /
// Accept-Language.
export function resolveLocale(tag: string | null | undefined): Locale {
  if (!tag) return DEFAULT_LOCALE;
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

// Human-readable labels for the language switcher.
export const LOCALE_LABELS: Record<Locale, { native: string; english: string }> = {
  en: { native: "English", english: "English" },
  zh: { native: "中文", english: "Chinese" },
};
