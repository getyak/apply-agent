import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ErrorToastContainer } from "@/components/errors";
import { HealthBanner } from "@/components/layout/HealthBanner";
import {
  HREFLANG,
  OG_LOCALE,
  SITE_NAME,
  SITE_URL,
  TWITTER_HANDLE,
  type SeoLocale,
} from "@/lib/site";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const inter = Inter({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  const locale = (await getLocale()) as SeoLocale;
  const title = t("title");
  const description = t("description");

  // hreflang map covers every locale we ship copy for; x-default points to /
  // so crawlers landing without a language hint reach the same canonical URL
  // we serve everyone (the cookie-based switcher then localizes in place).
  const languages: Record<string, string> = { "x-default": SITE_URL };
  for (const l of Object.keys(HREFLANG) as SeoLocale[]) {
    languages[HREFLANG[l]] = SITE_URL;
  }

  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: title,
      template: `%s · ${SITE_NAME}`,
    },
    description,
    applicationName: SITE_NAME,
    referrer: "origin-when-cross-origin",
    keywords: [
      "AI job search",
      "résumé tailoring",
      "interview prep",
      "ATS autofill",
      "LangGraph agents",
      "job application agent",
    ],
    authors: [{ name: SITE_NAME }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    formatDetection: { email: false, telephone: false, address: false },
    alternates: {
      canonical: "/",
      languages,
    },
    openGraph: {
      type: "website",
      locale: OG_LOCALE[locale],
      alternateLocale: (Object.keys(OG_LOCALE) as SeoLocale[])
        .filter((l) => l !== locale)
        .map((l) => OG_LOCALE[l]),
      url: SITE_URL,
      siteName: SITE_NAME,
      title,
      description,
      // opengraph-image.tsx in the same folder is auto-discovered by Next as
      // og:image; we explicitly list it here so the alt text stays editable
      // and the override is obvious to future readers.
      images: [
        {
          url: "/opengraph-image",
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/opengraph-image"],
      ...(TWITTER_HANDLE ? { creator: TWITTER_HANDLE, site: TWITTER_HANDLE } : {}),
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icon.svg", type: "image/svg+xml" },
      ],
      apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
    },
    manifest: "/manifest.webmanifest",
    category: "productivity",
  };
}

// Next 16 splits theme-color / color-scheme / viewport out of `metadata` into
// a dedicated `viewport` export. Keeping them here means crawlers and mobile
// browsers see the warm-paper brand chrome immediately (before CSS paints).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF8F6" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1815" },
  ],
  colorScheme: "light",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Locale resolved by src/i18n/request.ts (cookie → Accept-Language → "en").
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body className="bg-paper text-ink">
        <NextIntlClientProvider>
          {/* HealthBanner sits before children so a degraded gateway
              announces itself at the top of every page (W5.1). It's a
              no-op when status === "ok". */}
          <HealthBanner />
          {children}
          {/* Toasts mount once at the root so any client component can
              call emitErrorToast() without prop-drilling. The container
              renders fixed bottom-right and stacks. */}
          <ErrorToastContainer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
