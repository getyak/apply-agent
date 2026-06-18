export const metadata = {
  title: "Security · Vantage",
  description: "How Vantage protects your account, data, and job-search trust.",
};

export default function SecurityPage() {
  return (
    <article className="prose prose-sm max-w-none">
      <h1 className="font-display text-[32px] font-bold -tracking-[0.3px] text-ink leading-tight mt-2">
        Security
      </h1>
      <p className="font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
        Last updated · 2026-06-18 · placeholder
      </p>

      <section className="mt-8 space-y-4 font-body text-[15px] text-ink leading-relaxed">
        <h2 className="font-display text-[20px] font-bold text-ink">
          Client-side delivery
        </h2>
        <p>
          Job applications are submitted from your own browser, in your own
          session, on your own IP. We never operate a job board on your behalf
          from a remote server, and we never ask for your job-board passwords.
        </p>
        <h2 className="font-display text-[20px] font-bold text-ink mt-8">
          Account
        </h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Passwords are hashed (bcrypt-class) and never logged.</li>
          <li>JWT sessions are scoped per device and revocable from settings.</li>
          <li>2FA is on our roadmap for the first public release.</li>
        </ul>
        <h2 className="font-display text-[20px] font-bold text-ink mt-8">
          Reporting an issue
        </h2>
        <p>
          Please open a ticket at <code>security@vantage</code> or follow the
          <code> SECURITY.md </code>
          process in our repo. We take any account-safety report seriously.
        </p>
      </section>
    </article>
  );
}
