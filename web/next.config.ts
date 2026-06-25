import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Point the plugin at our request config (no-prefix, cookie-based locale).
// Works with both the Webpack dev server and the default Turbopack build.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  /* config options here */
};

export default withNextIntl(nextConfig);
