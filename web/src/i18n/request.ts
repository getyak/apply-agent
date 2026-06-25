import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, resolveLocale } from "./config";

// next-intl request config for the no-prefix (cookie-based) strategy.
//
// Resolution order on the server:
//   1. NEXT_LOCALE cookie (set by the language switcher) — explicit user choice.
//   2. Accept-Language header — first-visit browser detection.
//   3. DEFAULT_LOCALE ("en") — final fallback.
//
// We MUST return `locale` explicitly here: in a setup without locale-based
// routing the next-intl middleware never runs, so without this the library
// throws "Unable to find next-intl locale". (Next.js 16 makes cookies()/
// headers() async — both are awaited below.)
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;

  let locale = DEFAULT_LOCALE;
  if (isLocale(cookieLocale)) {
    locale = cookieLocale;
  } else {
    const headerStore = await headers();
    locale = resolveLocale(headerStore.get("accept-language"));
  }

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
