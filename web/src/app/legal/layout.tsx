import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-paper">
      <header className="max-w-[820px] mx-auto px-8 pt-10 pb-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1 font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted hover:text-ink transition-colors"
        >
          <ArrowLeft size={11} /> Back to home
        </Link>
        <div className="mt-6 font-display text-[18px] font-bold tracking-[3px] text-brown">
          VANTAGE
        </div>
      </header>
      <main className="max-w-[820px] mx-auto px-8 pb-24">{children}</main>
    </div>
  );
}
