"use client";

import { useTransition } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALES, type Locale } from "@/i18n/config";
import { persistLocale } from "@/i18n/locale-client";
import { cn } from "@/components/ui/cn";

// Segmented EN / 中文 control. Writes the NEXT_LOCALE cookie + localStorage
// mirror, then router.refresh() so the server re-resolves messages for the
// whole tree (no-prefix strategy — the URL never changes).
//
// `variant="segmented"` is the default settings/standalone look. `variant="inline"`
// is a slimmer pill for the sidebar/dock footer.

const LABELS: Record<Locale, string> = {
  en: "EN",
  zh: "中文",
};

interface Props {
  variant?: "segmented" | "inline";
  className?: string;
}

export function LanguageSwitcher({ variant = "segmented", className }: Props) {
  const active = useLocale() as Locale;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(locale: Locale) {
    if (locale === active) return;
    persistLocale(locale);
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div
      role="group"
      aria-label="Language"
      data-pending={pending ? "" : undefined}
      className={cn(
        "inline-flex items-center gap-[2px] rounded-full border border-cream-border bg-paper/60 p-[3px]",
        variant === "inline" && "scale-95",
        pending && "opacity-70",
        className,
      )}
    >
      {LOCALES.map((locale) => {
        const isActive = locale === active;
        return (
          <button
            key={locale}
            type="button"
            onClick={() => choose(locale)}
            aria-pressed={isActive}
            disabled={pending}
            className={cn(
              "cursor-pointer rounded-full px-[12px] py-[5px] font-body text-[12px] font-semibold transition-all duration-200",
              "[transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-1 focus-visible:ring-offset-paper",
              isActive
                ? "bg-brown text-paper shadow-[0_1px_2px_rgba(61,42,20,0.25)]"
                : "text-ink/55 hover:text-ink",
            )}
          >
            {LABELS[locale]}
          </button>
        );
      })}
    </div>
  );
}
