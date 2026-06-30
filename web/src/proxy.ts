import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Token cookie is mirrored from localStorage by `web/src/lib/api.ts`.
// Keep this name in sync with TOKEN_COOKIE there.
const TOKEN_COOKIE = "vantage_token";

// The proxy (Next 16's replacement for legacy middleware) runs at the edge
// before any route renders. Its single job here is to short-circuit the
// localStorage-only auth dance described in test.md § 3.2: the layout used
// to SSR a blank "Loading…" placeholder for every /app/* request because
// `getToken()` is client-only. Now we read the cookie at the edge and:
//
//   - If a guest hits /app/*, bounce to / with ?source=app_redirect so the
//     landing page can show a "please sign in first" banner.
//   - If a signed-in user hits /auth, send them straight to /app — no need
//     to render the form and immediately replace().
//
// We deliberately do NOT verify the JWT signature here; that stays in the
// API layer. The cookie is presence-checked only, so a forged cookie just
// gets a 401 on the first API call and is then cleared. Defense in depth
// still lives in `app/app/layout.tsx`'s me() guard.

const APP_PREFIX = "/app";
const AUTH_PATH = "/auth";

// True for the workspace root (/app) and any nested route (/app/today, …),
// but NOT for sibling routes that happen to start with the same characters
// like /apple-icon or /apps-marketing. startsWith("/app") would catch those
// and 307 them to /?source=app_redirect, breaking SEO + favicon fetches.
function isAppRoute(pathname: string): boolean {
  return pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`);
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasToken = Boolean(request.cookies.get(TOKEN_COOKIE)?.value);

  // Guard 1: guest visiting /app/* → punt to landing with a hint.
  if (!hasToken && isAppRoute(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("source", "app_redirect");
    return NextResponse.redirect(url, 307);
  }

  // Guard 2: signed-in user already at /auth → take them home.
  // Skip when the URL carries reason=session_expired / session_timeout, so
  // we don't loop back into /app after the layout itself bounced us out.
  if (hasToken && pathname === AUTH_PATH) {
    const reason = request.nextUrl.searchParams.get("reason");
    if (!reason) {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      url.search = "";
      return NextResponse.redirect(url, 307);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on app + auth + landing. Skip static assets and API proxies so we
  // don't accidentally block CSS/JS/image loads.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)",
  ],
};

// Echo proxy as default export too — keeps backward compatibility with the
// older `middleware` convention name that Next.js still aliases.
export default proxy;
// Also export under the legacy name for the deprecated middleware.ts alias,
// since some build configs still look for `middleware`.
export { proxy as middleware };
