"use client";

import { useVantage, JOBS, type ParsedResume, type CurrentUser } from "@/lib/store";
import { Button } from "@/components/ui";

// Pull the demo applicant identity from whatever real data the user already has.
// Falls back to a generic placeholder only when nothing is loaded — never to hardcoded
// "Jordan Avery" PII the way the legacy mock did.
function profileFields(currentUser: CurrentUser | null, parsedResume: ParsedResume | null) {
  const name = parsedResume?.basics?.name || currentUser?.displayName || "Your name";
  const email = currentUser?.email || "you@example.com";
  // We don't yet capture phone in CurrentUser/ParsedResume; until we do, surface a
  // neutral placeholder rather than fabricate digits.
  const phone = "Add a phone in settings";
  return [
    { label: "Full name", value: name, placeholder: "Your full name" },
    { label: "Email", value: email, placeholder: "you@example.com" },
    { label: "Phone", value: phone, placeholder: "(000) 000-0000" },
  ] as const;
}

export function ExtensionScreen() {
  const activeId = useVantage((s) => s.activeId);
  const eFilled = useVantage((s) => s.eFilled);
  const closeExt = useVantage((s) => s.closeExt);
  const extSubmit = useVantage((s) => s.extSubmit);
  const currentUser = useVantage((s) => s.currentUser);
  const parsedResume = useVantage((s) => s.parsedResume);

  const job = JOBS.find((j) => j.id === activeId);
  if (!job) return null;

  const fields = profileFields(currentUser, parsedResume);
  const domain = job.domain ?? job.co.toLowerCase();
  const slug = job.slug ?? job.role.toLowerCase().replace(/\s+/g, "-");
  const whyValue = job.whyShort ?? "";

  return (
    <div className="relative h-full w-full overflow-hidden bg-cream">
      {/* Fake browser chrome — neutral, host-system grey is fine here since it represents the ATS host */}
      <div className="flex h-[46px] items-center gap-3 border-b border-border-dark bg-paper px-4">
        <div className="flex items-center gap-2" aria-hidden>
          <span className="h-3 w-3 rounded-full bg-[#f0625a]" />
          <span className="h-3 w-3 rounded-full bg-[#f5be4f]" />
          <span className="h-3 w-3 rounded-full bg-[#5ec05a]" />
        </div>
        <div className="mx-2 flex h-[28px] flex-1 items-center rounded-md bg-white px-3 font-mono text-[12px] text-ink-light shadow-sm">
          jobs.{domain}.com/apply/{slug}
        </div>
        <Button onClick={closeExt} variant="ghost" size="sm" className="!font-medium">
          Close demo
        </Button>
      </div>

      {/* ATS form area */}
      <div className="h-[calc(100vh-46px)] overflow-y-auto bg-white">
        <div className="mx-auto max-w-[620px] px-6 py-12 pb-32">
          <div className="flex items-center gap-4">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-md bg-dark text-[18px] font-bold text-white"
              style={{ fontFamily: "Georgia, serif" }}
              aria-label={`${job.co} logo`}
            >
              {job.mono}
            </div>
            <span className="font-mono text-[12px] uppercase tracking-wider text-ink-muted">
              {job.co}
            </span>
          </div>

          <h1
            className="mt-6 text-[26px] font-bold leading-tight text-dark"
            style={{ fontFamily: "Georgia, serif" }}
          >
            {job.role}
          </h1>
          <p className="mt-2 text-[14px] text-ink-light">
            {job.location} · Apply for this job
          </p>

          <div className="mt-10 space-y-6">
            {fields.map((f) => (
              <FormField
                key={f.label}
                label={f.label}
                placeholder={f.placeholder}
                value={f.value}
                filled={eFilled}
              />
            ))}
            <FormField
              label={`Why are you interested in ${job.co}?`}
              placeholder="Tell us what draws you to this role…"
              value={whyValue}
              filled={eFilled}
              textarea
            />
          </div>

          {/* ATS-native submit visually disabled; the Vantage panel is the actual submit affordance */}
          <button
            type="button"
            disabled
            className="mt-8 rounded-md bg-[#2f6fdb] px-5 py-2.5 text-[14px] font-semibold text-white opacity-60 cursor-not-allowed"
            aria-label="ATS Submit (disabled in demo)"
          >
            Submit application
          </button>
        </div>
      </div>

      {/* Vantage assistant panel */}
      <div
        key={eFilled ? "filled" : "filling"}
        className="animate-pop absolute right-[28px] top-[70px] w-[330px] overflow-hidden rounded-xl border border-cream-border bg-paper shadow-2xl"
        role="dialog"
        aria-label="Vantage assistant"
      >
        <div className="flex items-center gap-2 bg-brown px-4 py-3">
          <span className="font-display text-[15px] font-bold text-white">Vantage</span>
          <span className="ml-auto font-mono text-[11px] uppercase tracking-wider text-gold-light">
            On this page
          </span>
        </div>

        <div className="p-4">
          {!eFilled ? (
            <div className="flex items-center gap-3 py-2" role="status" aria-live="polite">
              <span className="animate-spin h-5 w-5 rounded-full border-2 border-cream-border border-t-brown" />
              <span className="text-[14px] text-ink-light">Filling the form for you…</span>
            </div>
          ) : (
            <div className="animate-fade-in space-y-4">
              <div className="flex items-start gap-2">
                <span
                  className="animate-check mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green text-[12px] text-white"
                  aria-hidden
                >
                  ✓
                </span>
                <p className="text-[14px] leading-snug text-ink">
                  I filled 4 fields from your profile — name, email, phone, and a tailored answer below.
                </p>
              </div>

              <div className="rounded-lg border border-cream-border bg-gold-bg p-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-amber">
                  AI drafted answer
                </span>
                <p className="mt-1.5 text-[13px] leading-snug text-ink">{whyValue}</p>
              </div>

              <div className="flex items-start gap-2 rounded-lg bg-green-bg p-3">
                <span className="mt-0.5 text-[13px]" aria-hidden>
                  🔒
                </span>
                <p className="text-[13px] font-medium leading-snug text-green">
                  You press submit, not us.
                </p>
              </div>

              <Button onClick={extSubmit} fullWidth size="md">
                Mark as submitted
              </Button>
              <Button onClick={closeExt} variant="ghost" size="sm" fullWidth>
                Not now
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FormField({
  label,
  placeholder,
  value,
  filled,
  textarea,
}: {
  label: string;
  placeholder: string;
  value: string;
  filled: boolean;
  textarea?: boolean;
}) {
  const showValue = filled && Boolean(value);
  return (
    <div>
      <label
        className="mb-1.5 block text-[13px] font-semibold text-ink"
        style={{ fontFamily: "Arial, sans-serif" }}
      >
        {label}
      </label>
      <div
        className={`relative flex rounded-md border bg-white text-[14px] transition-colors ${
          showValue ? "border-amber" : "border-border-dark"
        } ${textarea ? "min-h-[88px] items-start" : "h-[42px] items-center"}`}
      >
        <span
          className={`px-3 ${textarea ? "py-2.5" : ""} ${showValue ? "text-ink" : "text-ink-muted"}`}
        >
          {showValue ? value : placeholder}
        </span>
        {showValue && (
          <span
            className="animate-check absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-amber text-[10px] text-white"
            aria-label="Filled by Vantage"
          >
            ✓
          </span>
        )}
      </div>
    </div>
  );
}
