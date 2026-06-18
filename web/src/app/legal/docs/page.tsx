import Link from "next/link";

export const metadata = {
  title: "Docs · Vantage",
  description: "Pointers to architecture notes and product specs for Vantage.",
};

export default function DocsPage() {
  return (
    <article className="prose prose-sm max-w-none">
      <h1 className="font-display text-[32px] font-bold -tracking-[0.3px] text-ink leading-tight mt-2">
        Docs
      </h1>
      <p className="font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
        Last updated · 2026-06-18 · placeholder
      </p>

      <section className="mt-8 space-y-4 font-body text-[15px] text-ink leading-relaxed">
        <p>
          The full documentation portal is still being assembled. For now, the
          short version of who we are and how we build:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Vision</strong> — quality over quantity, client-side
            delivery, and an honest résumé that never gets fabricated.
          </li>
          <li>
            <strong>Architecture</strong> — a hybrid TypeScript API layer and a
            Python LangGraph agent layer talking to PostgreSQL, Redis, and
            MinIO.
          </li>
          <li>
            <strong>Data flywheel</strong> — the more you mock-interview, the
            more useful Vantage becomes. Opt-in always.
          </li>
        </ul>
        <p>
          Want to see how a feature works under the hood? Open an issue or
          <Link href="/" className="text-brown font-semibold hover:underline ml-1">
            head back to the home page
          </Link>{" "}
          and try it for yourself.
        </p>
      </section>
    </article>
  );
}
