import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ErrorToastContainer } from "@/components/errors";
import { HealthBanner } from "@/components/layout/HealthBanner";
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
  return {
    title: t("title"),
    description: t("description"),
  };
}

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
