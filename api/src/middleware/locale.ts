import type { Context, Next } from "hono";
import { type SupportedLocale, resolveLocale } from "../locale";
import type { AppEnv } from "../types";

// Locale middleware — sits AFTER trace/request id and BEFORE routes so
// every handler can read `c.get("locale")` without re-resolving headers,
// and every response echoes the resolved locale on `X-Relay-Locale` for
// the web layer to confirm.
//
// Why echo it back: the web error-router and the dock both want to render
// in the same locale the server resolved (otherwise a client-side mismatch
// — wrong cookie, fresh tab — silently renders English while the body was
// already produced in zh, or vice versa). Echoing the resolved locale on
// every response closes that loop and matches the X-Trace-Id / X-Request-Id
// echo pattern (docs/architecture/error-handling.md §5).
//
// Precedence is owned by `resolveLocale` (locale.ts §header → Accept-Language
// → "en"). This middleware just memoizes the result + echoes the header.

const RELAY_LOCALE_HEADER = "X-Relay-Locale";

export async function locale(c: Context<AppEnv>, next: Next) {
  const resolved: SupportedLocale = resolveLocale(c);
  c.set("locale", resolved);
  c.header(RELAY_LOCALE_HEADER, resolved);
  await next();
}
