"use client";

import { useVantage, INTERVIEWING_DATA } from "@/lib/store";
import { Button } from "@/components/ui";

export function PrepModal() {
  const prepId = useVantage((s) => s.prepId);
  const closePrep = useVantage((s) => s.closePrep);
  const mockFromPrep = useVantage((s) => s.mockFromPrep);

  if (prepId === null) return null;
  const interview = INTERVIEWING_DATA[prepId];
  if (!interview) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm animate-fade-in"
      onClick={closePrep}
    >
      <div
        className="w-[560px] max-h-[88vh] overflow-y-auto rounded-2xl bg-paper shadow-xl animate-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-border px-7 pb-6 pt-7">
          <span className="font-mono text-[10px] uppercase tracking-wider rounded-full bg-gold-bg px-2.5 py-1 text-amber">
            Prep · ready when you are
          </span>
          <div className="mt-4 flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cream font-mono text-base font-medium text-brown">
              {interview.mono}
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-xl font-bold leading-tight text-ink">
                {interview.role}
              </h2>
              <p className="mt-1 text-sm text-ink-light">
                {interview.co} · {interview.stage} · {interview.when}
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-7 py-6">
          <h3 className="font-display text-sm font-semibold text-ink">
            Likely questions — with your angle
          </h3>
          <div className="mt-4 flex flex-col gap-3">
            {interview.qs.map((item, i) => (
              <div
                key={i}
                className="rounded-xl border border-border bg-white p-4"
              >
                <p className="text-[14px] font-semibold text-ink">{item.q}</p>
                <div className="mt-2.5 flex gap-3 pl-1">
                  <span className="w-[3px] shrink-0 rounded-full bg-cream-border" />
                  <p className="text-[13px] leading-relaxed text-ink-light">
                    {item.hint}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <h3 className="mt-7 font-display text-sm font-semibold text-ink">
            Know the room
          </h3>
          <div className="mt-3 rounded-xl border border-cream-border bg-cream p-4">
            <p className="text-[13px] leading-relaxed text-ink-light">
              {interview.brief}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-border px-7 py-5">
          <Button onClick={closePrep} variant="secondary" size="md" className="flex-1">
            Close
          </Button>
          <Button
            onClick={mockFromPrep}
            size="md"
            className="flex-[1.4]"
            leadingIcon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            }
          >
            Run a mock interview
          </Button>
        </div>
      </div>
    </div>
  );
}
