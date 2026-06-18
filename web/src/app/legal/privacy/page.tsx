export const metadata = {
  title: "Privacy · Vantage",
  description:
    "How Vantage handles your résumé, job search history, and personal data.",
};

export default function PrivacyPage() {
  return (
    <article className="prose prose-sm max-w-none">
      <h1 className="font-display text-[32px] font-bold -tracking-[0.3px] text-ink leading-tight mt-2">
        Privacy
      </h1>
      <p className="font-mono text-[11px] tracking-[0.4px] uppercase text-ink-muted">
        Last updated · 2026-06-18 · placeholder
      </p>

      <section className="mt-8 space-y-4 font-body text-[15px] text-ink leading-relaxed">
        <p>
          Vantage is built on the principle that your career data is yours. By
          design, the most sensitive parts of your job search — résumé content,
          tailored versions, interview history — can stay on your own device.
        </p>
        <h2 className="font-display text-[20px] font-bold text-ink mt-8">
          What we store on our servers
        </h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Account email and hashed password.</li>
          <li>
            Encrypted résumé blobs you explicitly upload, scoped to your user
            id; never reused for model training.
          </li>
          <li>Application metadata you ask the agent to track.</li>
        </ul>
        <h2 className="font-display text-[20px] font-bold text-ink mt-8">
          What we never collect
        </h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Passwords for job-board accounts (LinkedIn, Boss直聘, etc.).</li>
          <li>Anything that bypasses platform CAPTCHA or anti-bot controls.</li>
          <li>Behavioural ad signals.</li>
        </ul>
        <h2 className="font-display text-[20px] font-bold text-ink mt-8">
          Exports and deletion
        </h2>
        <p>
          You can export every byte we hold about you (GDPR-style JSON dump) or
          delete your account from <code>/app/settings</code>. Deletions are
          soft for 30 days, then purged.
        </p>
        <p className="text-ink-muted">
          A formal policy will replace this stub before public launch.
        </p>
      </section>
    </article>
  );
}
