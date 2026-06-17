"use client";

import { ArrowLeft, ArrowRight, Check, Sparkles } from "lucide-react";
import { useVantage, JOBS } from "@/lib/store";

export function ReviewScreen() {
  const activeId = useVantage((s) => s.activeId);
  const backHome = useVantage((s) => s.backHome);
  const submitReview = useVantage((s) => s.submitReview);
  const apiJobs = useVantage((s) => s.apiJobs);

  const job = JOBS.find((j) => j.id === activeId);
  const apiJob = apiJobs.find((j) => j.id === activeId);

  if (!job && !apiJob) return null;

  if (apiJob && !job) {
    const p = apiJob.parsed;
    const match = apiJob.matchScore ?? 50;
    const ringOffset = 195 - (195 * match) / 100;
    const location = p?.locations?.join(", ") || (p?.remote ? "Remote" : "");
    const salary = p?.salary_min && p?.salary_max ? `$${Math.round(p.salary_min / 1000)}–${Math.round(p.salary_max / 1000)}k` : "";
    const skills = p?.skills || [];
    const matched = apiJob.matchedSkills || [];
    const missing = apiJob.missingSkills || [];

    const TopBar = (
      <div className="h-[60px] shrink-0 border-b border-border bg-paper flex items-center px-5 gap-4">
        <button onClick={backHome} className="cursor-pointer inline-flex items-center gap-1.5 font-body font-medium text-[13.5px] text-ink-light hover:text-ink transition-colors bg-transparent border-none">
          <ArrowLeft size={15} /> Back
        </button>
        <span className="w-px h-5 bg-border-dark" />
        <span className="font-body text-[13.5px] text-ink-light">
          Review application · <span className="font-semibold text-ink">{apiJob.company}</span>
        </span>
      </div>
    );

    return (
      <div className="h-screen flex flex-col bg-paper">
        {TopBar}
        <div className="flex-1 flex min-h-0">
          <aside className="w-[360px] shrink-0 bg-[#FBF8F3] border-r border-border overflow-y-auto p-7">
            <div className="w-[54px] h-[54px] rounded-[13px] bg-cream border border-cream-border flex items-center justify-center mb-4 font-mono font-semibold text-[20px] text-brown">
              {apiJob.company.charAt(0)}
            </div>
            <h1 className="font-display font-bold text-[22px] text-ink leading-tight">{apiJob.role_title}</h1>
            <div className="font-body text-[14px] text-ink-light mt-1">
              {apiJob.company}{location ? ` · ${location}` : ""}{salary ? ` · ${salary}` : ""}
            </div>
            <div className="mt-7 flex items-center gap-4">
              <div className="relative w-[72px] h-[72px] shrink-0">
                <svg width="72" height="72" className="-rotate-90">
                  <circle cx="36" cy="36" r="31" fill="none" stroke="#E8DCCA" strokeWidth="6" />
                  <circle cx="36" cy="36" r="31" fill="none" stroke="#4C7A3F" strokeWidth="6" strokeLinecap="round" strokeDasharray="195" strokeDashoffset={ringOffset} />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="font-display font-bold text-[20px] text-green">{match}</span>
                </div>
              </div>
              <div>
                <div className="font-display font-bold text-[15px] text-ink">{match >= 85 ? "Strong fit" : match >= 70 ? "Good fit" : "Fair fit"}</div>
                <div className="font-body text-[13px] text-ink-light leading-[1.4]">{matched.length} skills matched</div>
              </div>
            </div>
            {matched.length > 0 && (
              <div className="mt-8">
                <h2 className="font-mono text-[10.5px] tracking-[0.6px] uppercase text-ink-muted mb-3.5">Matched skills</h2>
                <div className="flex flex-wrap gap-2">
                  {matched.map((s) => (
                    <span key={s} className="font-mono text-[10px] bg-green-bg text-green px-2 py-1 rounded">{s}</span>
                  ))}
                </div>
              </div>
            )}
            {missing.length > 0 && (
              <div className="mt-5">
                <h2 className="font-mono text-[10.5px] tracking-[0.6px] uppercase text-ink-muted mb-3.5">Skill gaps</h2>
                <div className="flex flex-wrap gap-2">
                  {missing.map((s) => (
                    <span key={s} className="font-mono text-[10px] bg-[#FFF3E0] text-amber px-2 py-1 rounded">{s}</span>
                  ))}
                </div>
              </div>
            )}
          </aside>

          <section className="flex-1 overflow-y-auto">
            <div className="max-w-[640px] mx-auto px-8 py-8">
              <h2 className="font-display font-bold text-[20px] text-ink">Your application</h2>
              <p className="font-body text-[13.5px] text-ink-light mt-1 mb-6">Review the details before submitting.</p>

              <div className="bg-white border border-border rounded-[14px] p-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display font-bold text-[15px] text-ink">Job details</h3>
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.4px] uppercase text-amber bg-gold-bg px-2 py-1 rounded-full shrink-0">
                    <Sparkles size={10} /> from database
                  </span>
                </div>
                <div className="mt-3 font-body text-[13.5px] leading-[1.55] text-ink">
                  <p><strong>Role:</strong> {apiJob.role_title}</p>
                  <p><strong>Company:</strong> {apiJob.company}</p>
                  {location && <p><strong>Location:</strong> {location}</p>}
                  {salary && <p><strong>Salary:</strong> {salary}</p>}
                  {skills.length > 0 && <p className="mt-2"><strong>Required skills:</strong> {skills.join(", ")}</p>}
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="shrink-0 border-t border-border bg-white flex items-center gap-4 px-6 py-3.5">
          <div className="flex items-center gap-2 font-body text-[13px] text-ink-light">
            <span className="w-[18px] h-[18px] rounded-full bg-green-bg flex items-center justify-center shrink-0">
              <Check size={11} className="text-green" strokeWidth={2.6} />
            </span>
            <span><span className="font-semibold text-ink">Match: {match}%</span> · {matched.length} skills aligned</span>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <button onClick={backHome} className="cursor-pointer font-body font-medium text-[13.5px] text-ink-light border border-border-dark bg-transparent px-4 py-[10px] rounded-[10px] hover:text-ink hover:border-ink-muted transition-colors">
              Save for later
            </button>
            <button onClick={submitReview} className="cursor-pointer font-body font-semibold text-[13.5px] text-paper bg-brown px-5 py-[10px] rounded-[10px] inline-flex items-center gap-2 hover:bg-brown-light transition-colors border-none">
              Submit application <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!job) return null;

  const ringOffset = 195 - (195 * job.match) / 100;

  const TopBar = (
    <div className="h-[60px] shrink-0 border-b border-border bg-paper flex items-center px-5 gap-4">
      <button
        onClick={backHome}
        className="cursor-pointer inline-flex items-center gap-1.5 font-body font-medium text-[13.5px] text-ink-light hover:text-ink transition-colors bg-transparent border-none"
      >
        <ArrowLeft size={15} />
        Back
      </button>
      <span className="w-px h-5 bg-border-dark" />
      <span className="font-body text-[13.5px] text-ink-light">
        Review application ·{" "}
        <span className="font-semibold text-ink">{job.co}</span>
      </span>
    </div>
  );

  // External / incomplete job — simpler view
  if (!job.ready || !job.whyBullets) {
    return (
      <div className="h-screen flex flex-col bg-paper">
        {TopBar}
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-[440px] text-center">
            <div className="w-[54px] h-[54px] rounded-[13px] bg-cream border border-cream-border flex items-center justify-center mx-auto mb-5 font-mono font-semibold text-[20px] text-brown">
              {job.mono}
            </div>
            <h1 className="font-display font-bold text-[22px] text-ink leading-tight mb-1">
              {job.role}
            </h1>
            <div className="font-body text-[14px] text-ink-light mb-5">
              {job.co} · {job.location}
            </div>
            {job.whyShort && (
              <p className="font-body text-[14px] leading-[1.6] text-ink-light bg-cream border border-cream-border rounded-[12px] p-4 mb-6 text-left">
                {job.whyShort}
              </p>
            )}
            <p className="font-body text-[13px] text-ink-muted mb-6">
              This role lives on an external site. We&apos;ll prep your package
              in the extension when you open it there.
            </p>
            <button
              onClick={backHome}
              className="cursor-pointer font-body font-semibold text-[14px] text-paper bg-brown px-6 py-[12px] rounded-[10px] inline-flex items-center gap-2 hover:bg-brown-light transition-colors border-none"
            >
              Back to today
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-paper">
      {TopBar}

      <div className="flex-1 flex min-h-0">
        {/* Left panel */}
        <aside className="w-[360px] shrink-0 bg-[#FBF8F3] border-r border-border overflow-y-auto p-7">
          <div className="w-[54px] h-[54px] rounded-[13px] bg-cream border border-cream-border flex items-center justify-center mb-4 font-mono font-semibold text-[20px] text-brown">
            {job.mono}
          </div>
          <h1 className="font-display font-bold text-[22px] text-ink leading-tight">
            {job.role}
          </h1>
          <div className="font-body text-[14px] text-ink-light mt-1">
            {job.co} · {job.location}
          </div>

          {/* Match ring */}
          <div className="mt-7 flex items-center gap-4">
            <div className="relative w-[72px] h-[72px] shrink-0">
              <svg width="72" height="72" className="-rotate-90">
                <circle
                  cx="36"
                  cy="36"
                  r="31"
                  fill="none"
                  stroke="#E8DCCA"
                  strokeWidth="6"
                />
                <circle
                  cx="36"
                  cy="36"
                  r="31"
                  fill="none"
                  stroke="#4C7A3F"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray="195"
                  strokeDashoffset={ringOffset}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-display font-bold text-[20px] text-green">
                  {job.match}
                </span>
              </div>
            </div>
            <div>
              <div className="font-display font-bold text-[15px] text-ink">
                Strong fit
              </div>
              <div className="font-body text-[13px] text-ink-light leading-[1.4]">
                You meet every must-have
              </div>
            </div>
          </div>

          {/* Why you're a fit */}
          <div className="mt-8">
            <h2 className="font-mono text-[10.5px] tracking-[0.6px] uppercase text-ink-muted mb-3.5">
              Why you&apos;re a fit
            </h2>
            <ul className="flex flex-col gap-3">
              {job.whyBullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="mt-[1px] w-[18px] h-[18px] rounded-full bg-green-bg flex items-center justify-center shrink-0">
                    <Check size={11} className="text-green" strokeWidth={2.6} />
                  </span>
                  <span className="font-body text-[13.5px] leading-[1.5] text-ink">
                    {b}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Right panel */}
        <section className="flex-1 overflow-y-auto">
          <div className="max-w-[640px] mx-auto px-8 py-8">
            <h2 className="font-display font-bold text-[20px] text-ink">
              Your application
            </h2>
            <p className="font-body text-[13.5px] text-ink-light mt-1 mb-6">
              The amber blocks were written for you — glance before you send.
            </p>

            {/* Tailored résumé */}
            <Card>
              <CardHeader title="Tailored résumé" tag="reordered for this role" />
              <ul className="flex flex-col gap-3 mt-3.5">
                {job.resumeBullets?.map((b, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-[7px] w-[5px] h-[5px] rounded-full bg-brown shrink-0" />
                    <span className="font-body text-[13.5px] leading-[1.55] text-ink">
                      {b}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            {/* Cover note */}
            <div className="mt-5 bg-[#FFFBF4] border border-cream-border rounded-[14px] p-5">
              <CardHeader title="Cover note" tag="draft" />
              <div
                contentEditable
                suppressContentEditableWarning
                className="mt-3.5 font-body text-[13.5px] leading-[1.65] text-ink whitespace-pre-wrap outline-none focus:bg-[#FFF8EA] rounded-[8px] -m-1 p-1 transition-colors"
              >
                {job.coverLetter}
              </div>
              <p className="mt-3 font-body text-[12px] text-ink-muted italic">
                Click to edit — this is your voice, adjust anything.
              </p>
            </div>

            {/* Screening questions */}
            {job.qa && job.qa.length > 0 && (
              <Card className="mt-5">
                <CardHeader title="Screening questions" tag="drafted" />
                <div className="flex flex-col gap-4 mt-3.5">
                  {job.qa.map((item, i) => (
                    <div key={i}>
                      <div className="font-body font-semibold text-[13.5px] text-ink mb-1.5">
                        {item.q}
                      </div>
                      <div className="font-body text-[13.5px] leading-[1.55] text-ink bg-[#FFFBF4] border border-cream-border rounded-[10px] p-3">
                        {item.a}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </section>
      </div>

      {/* Sticky submit bar */}
      <div className="shrink-0 border-t border-border bg-white flex items-center gap-4 px-6 py-3.5">
        <div className="flex items-center gap-2 font-body text-[13px] text-ink-light">
          <span className="w-[18px] h-[18px] rounded-full bg-green-bg flex items-center justify-center shrink-0">
            <Check size={11} className="text-green" strokeWidth={2.6} />
          </span>
          <span>
            <span className="font-semibold text-ink">9 fields ready</span> · 3
            written by AI — glance before you send
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <button
            onClick={backHome}
            className="cursor-pointer font-body font-medium text-[13.5px] text-ink-light border border-border-dark bg-transparent px-4 py-[10px] rounded-[10px] hover:text-ink hover:border-ink-muted transition-colors"
          >
            Save for later
          </button>
          <button
            onClick={submitReview}
            className="cursor-pointer font-body font-semibold text-[13.5px] text-paper bg-brown px-5 py-[10px] rounded-[10px] inline-flex items-center gap-2 hover:bg-brown-light transition-colors border-none"
          >
            Looks right — submit
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-white border border-border rounded-[14px] p-5 ${className}`}
    >
      {children}
    </div>
  );
}

function CardHeader({ title, tag }: { title: string; tag: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-display font-bold text-[15px] text-ink">{title}</h3>
      <span className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.4px] uppercase text-amber bg-gold-bg px-2 py-1 rounded-full shrink-0">
        <Sparkles size={10} />
        AI · {tag}
      </span>
    </div>
  );
}
