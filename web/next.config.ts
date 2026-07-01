import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Point the plugin at our request config (no-prefix, cookie-based locale).
// Works with both the Webpack dev server and the default Turbopack build.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Dev-only: Next blocks HMR/webpack resources from origins it considers
  // cross-origin. Without this, opening the app via 127.0.0.1 silently breaks
  // client hydration (forms render but onClick/onSubmit never fire) while
  // localhost works. Listing both keeps either host usable in dev / Playwright.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default withNextIntl(nextConfig);
