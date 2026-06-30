import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Block crawlers from indexing private app surfaces and one-off short links —
// only the marketing landing + /auth + /legal/* belong in search results.
// The cookie-based locale strategy means /zh doesn't exist as a path, so no
// per-locale sitemap is needed; one sitemap covers everything.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/app/", "/r/", "/api/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
