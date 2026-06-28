// Locale resolver for the API layer.
//
// Two-dim locale (docs/architecture/vantage-ui-mapping.md):
//   - UI chrome locale       — section titles, action labels, system messages.
//                              Follows the user's UI language (cookie / header).
//   - Artifact content locale — résumé bullets, JD text, interview answers.
//                              Follows the artifact itself, never re-translated.
//
// This module owns the FIRST one. Pin order, identical to web/src/i18n:
//   1. Explicit X-Relay-Locale request header (set by the web client from the
//      next-intl NEXT_LOCALE cookie).
//   2. RFC 7231 Accept-Language header — anything Chinese → "zh", else "en".
//   3. Default → "en".
//
// Keep this resolver in one place so every Hono route hands the same locale
// to the same downstream helpers (canonical Markdown rendering, agent stream
// forwarding, etc.). When new locales land, add them to SupportedLocale +
// extend localeFromHeader's regex — do not fork per-route copies.

import type { Context } from "hono";

export type SupportedLocale = "en" | "zh";

export const DEFAULT_LOCALE: SupportedLocale = "en";

const RELAY_LOCALE_HEADER = "x-relay-locale";

/** Map an Accept-Language header to a SupportedLocale. */
export function localeFromHeader(acceptLanguage: string | undefined): SupportedLocale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  return /(^|[,;\s])zh/i.test(acceptLanguage) ? "zh" : DEFAULT_LOCALE;
}

/** Coerce arbitrary input (header, body field) to a SupportedLocale. */
export function coerceLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "zh" || v.startsWith("zh-")) return "zh";
  if (v === "en" || v.startsWith("en-")) return "en";
  return null;
}

/**
 * Resolve the request's UI locale, honoring the precedence above. Reads the
 * Hono Context directly so routes don't have to fish header values out by
 * hand.
 */
export function resolveLocale(c: Context): SupportedLocale {
  const explicit = coerceLocale(c.req.header(RELAY_LOCALE_HEADER));
  if (explicit) return explicit;
  return localeFromHeader(c.req.header("accept-language"));
}
