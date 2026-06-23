"use client";

// Client-side locale helpers. Mirrors the cookie/localStorage pattern in
// lib/api.ts: the NEXT_LOCALE cookie is the source of truth the server reads
// (src/i18n/request.ts), localStorage is a JS-readable mirror so non-React code
// (the SSE client, the JSON API client) can stamp X-Relay-Locale headers
// without reaching into React context.

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_STORAGE_KEY,
  type Locale,
  isLocale,
  resolveLocale,
} from "./config";

// 1 year — language preference is sticky and low-risk.
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

// Read the active locale on the client. Order mirrors the server's
// (cookie → browser language), with localStorage as a same-origin fast path.
// Returns DEFAULT_LOCALE during SSR (no window).
export function getClientLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;

  const fromCookie = readCookie(LOCALE_COOKIE);
  if (isLocale(fromCookie)) return fromCookie;

  const fromStorage = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (isLocale(fromStorage)) return fromStorage;

  return resolveLocale(navigator.language);
}

// Persist a new locale to both cookie (server-readable) and localStorage
// (JS-readable mirror). Does NOT trigger a re-render — callers refresh the
// router so the server re-resolves messages.
export function persistLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax${secure}`;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}
