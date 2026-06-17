"use client";

import {
  useVantage,
  JOBS,
  INTERVIEWING_DATA,
  OUTCOME_DATA,
  type ApiJob,
} from "@/lib/store";
import { useEffect } from "react";
import {
  MessageSquare,
  Home,
  LayoutGrid,
  Calendar,
  FileText,
  Sparkles,
  Zap,
  Check,
  Send,
  ArrowUpRight,
  Clock,
  CheckCircle2,
} from "lucide-react";

function Sidebar() {
  const nav = useVantage((s) => s.nav);
  const applied = useVantage((s) => s.applied);
  const goChat = useVantage((s) => s.goChat);
  const goToday = useVantage((s) => s.goToday);
  const goTracker = useVantage((s) => s.goTracker);
  const goInterviews = useVantage((s) => s.goInterviews);
  const goBuilder = useVantage((s) => s.goBuilder);
  const goMockSetup = useVantage((s) => s.goMockSetup);

  const navItem = (active: boolean) =>
    `flex items-center gap-[10px] px-[10px] py-[9px] rounded-[9px] cursor-pointer text-[14px] font-medium transition-colors ${
      active
        ? "bg-cream text-brown font-semibold"
        : "text-ink-light hover:bg-[#F8F5F0] hover:text-ink"
    }`;

  return (
    <aside className="w-[248px] shrink-0 bg-white border-r border-border flex flex-col py-[22px] px-4">
      <div className="flex items-center gap-[9px] px-[10px] pb-[26px]">
        <div className="w-6 h-6 rounded-[6px] bg-brown flex items-center justify-center">
          <Check className="w-[14px] h-[14px] text-paper" strokeWidth={2.2} />
        </div>
        <span className="font-display font-bold text-[15px] tracking-[2.5px] text-brown">
          VANTAGE
        </span>
      </div>

      <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted px-[10px] pb-2">
        Workspace
      </div>
      <nav className="flex flex-col gap-[2px]">
        <div className={navItem(nav === "chat")} onClick={goChat}>
          <MessageSquare className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Ask Vantage</span>
        </div>
        <div className={navItem(nav === "today")} onClick={goToday}>
          <Home className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Today</span>
        </div>
        <div className={navItem(nav === "apps")} onClick={goTracker}>
          <LayoutGrid className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Applications</span>
          <span className="ml-auto font-mono text-[10px] font-medium bg-[#F3F0EB] text-ink-light px-[7px] py-[2px] rounded-full">
            {applied.length + INTERVIEWING_DATA.length + OUTCOME_DATA.length}
          </span>
        </div>
        <div className={navItem(false)} onClick={goInterviews}>
          <Calendar className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Interviews</span>
          <span className="ml-auto w-[7px] h-[7px] rounded-full bg-amber" />
        </div>
      </nav>

      <div className="font-display font-bold text-[10px] tracking-[1.5px] uppercase text-ink-muted px-[10px] pt-6 pb-2 flex items-center gap-[7px]">
        <Sparkles className="w-3 h-3 text-amber" strokeWidth={1.8} />
        AI Studio
      </div>
      <nav className="flex flex-col gap-[2px]">
        <div className={navItem(false)} onClick={goBuilder}>
          <FileText className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Résumé studio</span>
        </div>
        <div className={navItem(false)} onClick={goMockSetup}>
          <MessageSquare className="w-[18px] h-[18px]" strokeWidth={1.7} />
          <span>Mock interview</span>
        </div>
      </nav>

      <div className="mt-auto" />

      <div className="bg-[#FBF8F3] border border-border rounded-xl p-[14px] mb-3">
        <div className="flex items-center justify-between mb-[9px]">
          <span className="font-mono text-[10px] tracking-[0.6px] uppercase text-ink-light">
            Auto-applies
          </span>
          <span className="font-mono text-[10px] tracking-[0.6px] text-brown">
            14 / 40
          </span>
        </div>
        <div className="h-[6px] rounded-full bg-border overflow-hidden">
          <div className="h-full rounded-full bg-brown" style={{ width: "35%" }} />
        </div>
        <div className="font-body text-[11px] text-ink-muted mt-[9px]">
          Resets in 14 days ·{" "}
          <span className="text-brown font-semibold cursor-pointer">Upgrade</span>
        </div>
      </div>

      <div className="flex items-center gap-[10px] px-2 py-[6px]">
        <div className="w-[34px] h-[34px] rounded-[9px] bg-brown flex items-center justify-center font-display font-bold text-[14px] text-paper">
          JA
        </div>
        <div className="min-w-0">
          <div className="font-body font-semibold text-[13px] text-ink truncate">
            Jordan Avery
          </div>
          <span className="font-mono text-[9px] tracking-[0.6px] uppercase text-amber bg-gold-bg px-[6px] py-[2px] rounded">
            Pro
          </span>
        </div>
      </div>
    </aside>
  );
}

const SUGGESTIONS = [
  { label: "Find new roles that fit me", id: "find" },
  { label: "Tailor my résumé for a role", id: "tailor" },
  { label: "Prep me for an interview", id: "prep" },
  { label: "Show me today's market", id: "market" },
];

function ChatView() {
  const chatLog = useVantage((s) => s.chatLog);
  const sendChat = useVantage((s) => s.sendChat);
  const runFlow = useVantage((s) => s.runFlow);
  const chatInput = useVantage((s) => s.chatInput);
  const setChatInput = useVantage((s) => s.setChatInput);
  const sendRealChat = useVantage((s) => s.sendRealChat);
  const chatMessages = useVantage((s) => s.chatMessages);
  const chatLoading = useVantage((s) => s.chatLoading);
  const goToday = useVantage((s) => s.goToday);
  const hasLog = chatLog.length > 0 || chatMessages.length > 0;

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {!hasLog && (
          <div className="max-w-[720px] mx-auto px-10 pt-[84px] pb-[30px] animate-fade-up">
            <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-3">
              Today · June 17, 2026
            </div>
            <h1 className="font-display font-bold text-[34px] -tracking-[0.4px] text-ink mb-2">
              Good morning, Jordan.
            </h1>
            <p className="font-body text-[17px] leading-[1.5] text-ink-light mb-[30px]">
              What should we work on? Ask anything — or launch a task and
              I&apos;ll run the agents.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {SUGGESTIONS.map((s) => (
                <div
                  key={s.id}
                  onClick={() => runFlow(s.id)}
                  className="cursor-pointer bg-white border border-border rounded-[13px] px-[18px] py-4 flex items-center gap-3 shadow-sm hover:border-brown hover:-translate-y-px transition-all"
                >
                  <div className="w-8 h-8 rounded-[9px] bg-cream flex items-center justify-center shrink-0">
                    <Zap className="w-4 h-4 text-brown" strokeWidth={1.8} />
                  </div>
                  <span className="font-body font-medium text-[14.5px] text-ink">
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasLog && (
          <div className="max-w-[720px] mx-auto px-10 pt-9 pb-5 flex flex-col gap-[18px]">
            {chatLog.map((entry) => (
              <div key={entry.key} className="flex flex-col gap-3">
                <div className="flex justify-end w-full">
                  <div className="bg-brown text-paper font-body text-[15px] leading-[1.5] px-4 py-[10px] rounded-[13px] rounded-br-[4px] max-w-[460px]">
                    Find new roles that fit my profile
                  </div>
                </div>

                <div className="flex gap-[10px] items-start">
                  <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                    <Check className="w-[15px] h-[15px] text-paper" strokeWidth={2.2} />
                  </div>
                  <div className="font-body text-[15px] leading-[1.55] text-ink max-w-[520px]">
                    On it — scanning job boards and matching against your skills
                    and experience.
                  </div>
                </div>

                <div className="flex gap-[10px] items-start">
                  <div className="w-[30px] shrink-0" />
                  <div className="flex flex-col gap-2 flex-1 max-w-[520px]">
                    <div className="flex items-center gap-[11px] bg-white border border-cream-border rounded-[10px] px-[14px] py-[11px]">
                      {entry.phase < 1 ? (
                        <div className="w-4 h-4 rounded-full border-2 border-[#F0E4D2] border-t-amber animate-spin shrink-0" />
                      ) : (
                        <div className="w-[22px] h-[22px] rounded-[6px] bg-cream flex items-center justify-center shrink-0">
                          <Zap className="w-[13px] h-[13px] text-brown" strokeWidth={2} />
                        </div>
                      )}
                      <span className="font-mono text-[10px] tracking-[0.5px] uppercase text-brown">
                        Job scanner
                      </span>
                      <span className={`ml-auto font-mono text-[10px] tracking-[0.5px] uppercase ${entry.phase < 1 ? "text-amber" : "text-green"}`}>
                        {entry.phase < 1 ? "scanning…" : "done"}
                      </span>
                    </div>
                  </div>
                </div>

                {entry.phase >= 1 && (
                  <div className="flex gap-[10px] items-start">
                    <div className="w-[30px] shrink-0" />
                    <div className="flex-1 max-w-[520px] bg-[#FFFBF4] border border-cream-border rounded-[13px] px-[18px] py-4 flex items-center gap-[14px] animate-pop">
                      <div className="w-[38px] h-[38px] rounded-[10px] bg-green-bg flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-[19px] h-[19px] text-green" strokeWidth={2} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-body font-semibold text-[15px] text-ink">
                          5 matching roles found
                        </div>
                        <div className="font-body text-[13px] text-ink-light mt-[2px]">
                          3 are ready to apply — check your briefing
                        </div>
                      </div>
                      <button
                        onClick={goToday}
                        className="cursor-pointer border-none bg-brown text-paper font-body font-semibold text-[13px] px-4 py-[10px] rounded-[9px] whitespace-nowrap shrink-0 hover:bg-brown-light transition-colors"
                      >
                        View matches
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatMessages.map((msg, i) => (
              <div key={`real-${i}`} className="flex flex-col gap-3">
                {msg.role === "user" ? (
                  <div className="flex justify-end w-full">
                    <div className="bg-brown text-paper font-body text-[15px] leading-[1.5] px-4 py-[10px] rounded-[13px] rounded-br-[4px] max-w-[460px]">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-[10px] items-start">
                    <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                      <Check className="w-[15px] h-[15px] text-paper" strokeWidth={2.2} />
                    </div>
                    <div className="font-body text-[15px] leading-[1.55] text-ink max-w-[520px] whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatLoading && (
              <div className="flex gap-[10px] items-start">
                <div className="w-[30px] h-[30px] rounded-lg bg-brown shrink-0 flex items-center justify-center">
                  <div className="w-4 h-4 rounded-full border-2 border-paper/30 border-t-paper animate-spin" />
                </div>
                <div className="font-body text-[15px] text-ink-light animate-pulse">
                  Thinking...
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-paper/90 backdrop-blur-xl px-10 py-4 pb-[22px]">
        <div className="max-w-[720px] mx-auto">
          {hasLog && (
            <div className="flex flex-wrap gap-2 mb-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => runFlow(s.id)}
                  className="cursor-pointer bg-white border border-border-dark text-ink font-body font-medium text-[12.5px] px-[13px] py-[7px] rounded-full hover:border-brown hover:bg-[#FFFDFB] transition-all"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); chatInput.trim() ? sendRealChat() : sendChat(); }}
            className="flex items-center gap-[10px] bg-white border border-border-dark rounded-[13px] pl-[18px] pr-[7px] py-[7px] shadow-sm"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask anything, or launch a task…"
              className="flex-1 font-body text-[15px] text-ink bg-transparent border-none outline-none placeholder:text-ink-muted"
            />
            <button
              type="submit"
              className="cursor-pointer border-none bg-brown w-[38px] h-[38px] rounded-[10px] flex items-center justify-center shrink-0 hover:bg-brown-light transition-colors"
            >
              <Send className="w-[17px] h-[17px] text-paper" strokeWidth={2} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function ApiJobCard({ job, onApply }: { job: ApiJob; onApply: (id: string) => void }) {
  const match = job.matchScore ?? 50;
  const fitColor = (m: number) => (m >= 90 ? "#4C7A3F" : m >= 85 ? "#5D3000" : "#A66A00");
  const fitBg = (m: number) => (m >= 90 ? "#EBF3E5" : m >= 85 ? "#F5EDE3" : "#F8ECD6");
  const fitLabel = (m: number) => (m >= 95 ? "Excellent" : m >= 90 ? "Strong" : m >= 85 ? "Good" : "Fair");
  const p = job.parsed;
  const location = p?.locations?.join(", ") || (p?.remote ? "Remote" : "");
  const salary = p?.salary_min && p?.salary_max ? `$${Math.round(p.salary_min / 1000)}–${Math.round(p.salary_max / 1000)}k` : "";

  return (
    <div className="bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px] hover:border-border-dark transition-colors">
      <div className="w-[46px] h-[46px] rounded-[11px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[19px] text-ink shrink-0">
        {job.company.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-[9px] mb-[3px]">
          <span className="font-body font-semibold text-[16px] text-ink">{job.role_title}</span>
          <span className="font-mono text-[10px] tracking-[0.4px] uppercase px-2 py-[3px] rounded-[5px]" style={{ color: fitColor(match), background: fitBg(match) }}>
            {fitLabel(match)}
          </span>
        </div>
        <div className="font-body text-[13px] text-ink-light">
          {job.company}{location ? ` · ${location}` : ""}{salary ? ` · ${salary}` : ""}
        </div>
        <div className="flex items-center gap-[10px] mt-[11px]">
          <div className="w-[120px] h-[6px] rounded-full bg-border overflow-hidden">
            <div className="h-full rounded-full bg-green" style={{ width: `${match}%` }} />
          </div>
          <span className="font-mono text-[11px] font-medium text-green">{match}% match</span>
        </div>
        {job.matchedSkills && job.matchedSkills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {job.matchedSkills.slice(0, 4).map((s) => (
              <span key={s} className="font-mono text-[9px] tracking-[0.3px] uppercase bg-green-bg text-green px-[6px] py-[2px] rounded">{s}</span>
            ))}
            {job.missingSkills && job.missingSkills.length > 0 && (
              <span className="font-mono text-[9px] tracking-[0.3px] uppercase bg-[#FFF3E0] text-amber px-[6px] py-[2px] rounded">+{job.missingSkills.length} gaps</span>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0">
        <button
          onClick={() => onApply(job.id)}
          className="border-none cursor-pointer bg-brown text-paper font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap hover:bg-brown-light transition-colors"
        >
          <Zap className="w-[15px] h-[15px]" strokeWidth={1.9} />
          Review & apply
        </button>
      </div>
    </div>
  );
}

function TodayView() {
  const openReview = useVantage((s) => s.openReview);
  const openExtension = useVantage((s) => s.openExtension);
  const apiJobs = useVantage((s) => s.apiJobs);
  const apiJobsLoading = useVantage((s) => s.apiJobsLoading);
  const trendSnapshot = useVantage((s) => s.trendSnapshot);
  const loadJobs = useVantage((s) => s.loadJobs);
  const loadTrends = useVantage((s) => s.loadTrends);

  useEffect(() => {
    if (apiJobs.length === 0 && !apiJobsLoading) {
      loadJobs();
      loadTrends();
    }
  }, []);

  const fitColor = (m: number) => (m >= 90 ? "#4C7A3F" : m >= 85 ? "#5D3000" : "#A66A00");
  const fitBg = (m: number) => (m >= 90 ? "#EBF3E5" : m >= 85 ? "#F5EDE3" : "#F8ECD6");
  const fitLabel = (m: number) => (m >= 95 ? "Excellent" : m >= 90 ? "Strong" : m >= 85 ? "Good" : "Fair");

  const totalJobs = trendSnapshot?.totalJobs ?? 12;
  const strongFits = apiJobs.filter((j) => (j.matchScore ?? 0) >= 85).length || 6;

  return (
    <div className="max-w-[880px] mx-auto px-12 pt-10 pb-20 animate-fade-up">
      <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-[10px]">
        Today · June 17, 2026
      </div>
      <h1 className="font-display font-bold text-[32px] -tracking-[0.3px] text-ink mb-[22px]">
        Good morning, Jordan.
      </h1>

      <div className="flex bg-white border border-border rounded-[13px] shadow-sm overflow-hidden mb-[34px]">
        <div className="flex-1 px-[22px] py-[18px]">
          <div className="font-display font-bold text-[26px] text-ink">{totalJobs}</div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            roles in database
          </div>
        </div>
        <div className="w-px bg-border" />
        <div className="flex-1 px-[22px] py-[18px]">
          <div className="font-display font-bold text-[26px] text-green">{strongFits}</div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            strong fits, ready to send
          </div>
        </div>
        <div className="w-px bg-border" />
        <div className="flex-1 px-[22px] py-[18px]">
          <div className="font-display font-bold text-[26px] text-amber">
            {trendSnapshot?.topSkills?.length ?? 0}
          </div>
          <div className="font-body text-[13px] text-ink-light mt-[2px]">
            trending skills tracked
          </div>
        </div>
      </div>

      {/* API Jobs Section */}
      {apiJobs.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mb-[14px]">
            <h2 className="font-display font-bold text-[13px] tracking-[1.5px] uppercase text-ink-light m-0">
              Live matches
            </h2>
            <span className="font-body text-[13px] text-ink-muted">From database · sorted by fit</span>
          </div>
          <div className="flex flex-col gap-[13px] mb-[34px]">
            {apiJobs.map((job) => (
              <ApiJobCard key={job.id} job={job} onApply={(id) => openReview(id)} />
            ))}
          </div>
        </>
      )}

      {apiJobsLoading && (
        <div className="flex items-center gap-3 mb-[34px] p-4 bg-white border border-border rounded-[13px]">
          <div className="w-5 h-5 rounded-full border-2 border-[#F0E4D2] border-t-amber animate-spin" />
          <span className="font-body text-[14px] text-ink-light">Loading jobs and computing match scores...</span>
        </div>
      )}

      <div className="flex items-baseline justify-between mb-[14px]">
        <h2 className="font-display font-bold text-[13px] tracking-[1.5px] uppercase text-ink-light m-0">
          Demo matches
        </h2>
        <span className="font-body text-[13px] text-ink-muted">Sorted by fit</span>
      </div>

      <div className="flex flex-col gap-[13px]">
        {JOBS.map((job) => (
          <div
            key={job.id}
            className="bg-white border border-border rounded-[14px] px-[22px] py-5 shadow-sm flex items-center gap-[18px] hover:border-border-dark transition-colors"
          >
            <div className="w-[46px] h-[46px] rounded-[11px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[19px] text-ink shrink-0">
              {job.mono}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-[9px] mb-[3px]">
                <span className="font-body font-semibold text-[16px] text-ink">
                  {job.role}
                </span>
                <span
                  className="font-mono text-[10px] tracking-[0.4px] uppercase px-2 py-[3px] rounded-[5px]"
                  style={{ color: fitColor(job.match), background: fitBg(job.match) }}
                >
                  {fitLabel(job.match)}
                </span>
              </div>
              <div className="font-body text-[13px] text-ink-light">
                {job.co} · {job.location}
                {job.salary && ` · ${job.salary}`}
              </div>
              <div className="flex items-center gap-[10px] mt-[11px]">
                <div className="w-[120px] h-[6px] rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green"
                    style={{ width: `${job.match}%` }}
                  />
                </div>
                <span className="font-mono text-[11px] font-medium text-green">
                  {job.match}% match
                </span>
              </div>
            </div>
            <div className="shrink-0">
              {job.ready ? (
                <button
                  onClick={() => openReview(job.id)}
                  className="border-none cursor-pointer bg-brown text-paper font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap hover:bg-brown-light transition-colors"
                >
                  <Zap className="w-[15px] h-[15px]" strokeWidth={1.9} />
                  One-click apply
                </button>
              ) : (
                <button
                  onClick={() => openExtension(job.id)}
                  className="cursor-pointer bg-white text-ink border border-border-dark font-body font-semibold text-[14px] px-[18px] py-[11px] rounded-[9px] flex items-center gap-[7px] whitespace-nowrap hover:border-brown transition-colors"
                >
                  Apply on site
                  <ArrowUpRight className="w-[14px] h-[14px] text-ink-light" strokeWidth={1.9} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-[9px] justify-center font-body text-[13px] text-ink-muted">
        <Clock className="w-[15px] h-[15px]" strokeWidth={1.7} />
        Filled buttons mean everything&apos;s prepared. Outlined ones open the
        company&apos;s own site.
      </div>
    </div>
  );
}

function TrackerView() {
  const applied = useVantage((s) => s.applied);
  const openPrep = useVantage((s) => s.openPrep);
  const apiApplications = useVantage((s) => s.apiApplications);
  const loadApplications = useVantage((s) => s.loadApplications);

  useEffect(() => {
    loadApplications();
  }, []);

  return (
    <div className="px-12 pt-10 pb-[60px] animate-fade-up">
      <div className="font-mono text-[11px] tracking-[1px] uppercase text-ink-muted mb-[10px]">
        Pipeline
      </div>
      <h1 className="font-display font-bold text-[32px] -tracking-[0.3px] text-ink mb-[26px]">
        Applications
      </h1>

      {apiApplications.length > 0 && (
        <div className="mb-6 p-4 bg-[#FBF8F3] border border-border rounded-[13px]">
          <div className="font-mono text-[10px] tracking-[0.6px] uppercase text-ink-muted mb-2">
            Saved in database
          </div>
          <div className="flex flex-col gap-2">
            {apiApplications.map((app) => (
              <div key={app.id} className="flex items-center gap-3 bg-white border border-border rounded-lg px-3 py-2">
                <div className="w-[28px] h-[28px] rounded-[7px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[12px] text-ink shrink-0">
                  {(app.company || "?").charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-body font-semibold text-[13px] text-ink">{app.role_title || "Role"}</span>
                  <span className="font-body text-[12px] text-ink-light ml-2">{app.company || ""}</span>
                </div>
                <span className="font-mono text-[9px] tracking-[0.4px] uppercase text-amber bg-gold-bg px-[6px] py-[2px] rounded">
                  {app.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-[18px] items-start">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-[14px] px-[2px]">
            <span className="font-display font-bold text-[12px] tracking-[1.2px] uppercase text-ink-light">
              Applied
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              {applied.length}
            </span>
          </div>
          <div className="flex flex-col gap-[11px]">
            {applied.map((app, i) => (
              <div
                key={`${app.co}-${i}`}
                className={`bg-white border rounded-xl p-[15px] shadow-sm ${app.isNew ? "border-green bg-green-bg/30 animate-pop" : "border-border"}`}
              >
                <div className="flex items-center gap-[11px] mb-[10px]">
                  <div className="w-[34px] h-[34px] rounded-[9px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[14px] text-ink shrink-0">
                    {app.mono}
                  </div>
                  <div className="min-w-0">
                    <div className="font-body font-semibold text-[14px] text-ink truncate">
                      {app.role}
                    </div>
                    <div className="font-body text-[12px] text-ink-light">
                      {app.co}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] tracking-[0.4px] uppercase text-ink-muted">
                    {app.when}
                  </span>
                  {app.isNew && (
                    <span className="font-mono text-[9px] tracking-[0.5px] uppercase text-green bg-green-bg px-[7px] py-[3px] rounded">
                      Just sent
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-[14px] px-[2px]">
            <span className="font-display font-bold text-[12px] tracking-[1.2px] uppercase text-ink-light">
              Interviewing
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              {INTERVIEWING_DATA.length}
            </span>
          </div>
          <div className="flex flex-col gap-[11px]">
            {INTERVIEWING_DATA.map((app, i) => (
              <div
                key={`${app.co}-${i}`}
                className="bg-white border border-border rounded-xl p-[15px] shadow-sm"
              >
                <div className="flex items-center gap-[11px] mb-[11px]">
                  <div className="w-[34px] h-[34px] rounded-[9px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[14px] text-ink shrink-0">
                    {app.mono}
                  </div>
                  <div className="min-w-0">
                    <div className="font-body font-semibold text-[14px] text-ink truncate">
                      {app.role}
                    </div>
                    <div className="font-body text-[12px] text-ink-light">
                      {app.co}
                    </div>
                  </div>
                </div>
                <div className="bg-gold-bg rounded-lg px-[11px] py-[9px] mb-[11px]">
                  <div className="font-mono text-[9px] tracking-[0.5px] uppercase text-amber mb-[2px]">
                    {app.stage}
                  </div>
                  <div className="font-body font-semibold text-[13px] text-brown">
                    {app.when}
                  </div>
                </div>
                <button
                  onClick={() => openPrep(i)}
                  className="w-full cursor-pointer border border-cream-border bg-cream text-brown font-body font-semibold text-[13px] py-[9px] rounded-lg flex items-center justify-center gap-[7px] hover:bg-[#EFE3D2] transition-colors"
                >
                  <Sparkles className="w-[15px] h-[15px]" strokeWidth={1.7} />
                  Prep this interview
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-[14px] px-[2px]">
            <span className="font-display font-bold text-[12px] tracking-[1.2px] uppercase text-ink-light">
              Outcome
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              {OUTCOME_DATA.length}
            </span>
          </div>
          <div className="flex flex-col gap-[11px]">
            {OUTCOME_DATA.map((app, i) => (
              <div
                key={`${app.co}-${i}`}
                className={`bg-white border rounded-xl p-[15px] shadow-sm ${app.result === "Offer" ? "border-green" : "border-border"}`}
              >
                <div className="flex items-center gap-[11px] mb-[10px]">
                  <div className="w-[34px] h-[34px] rounded-[9px] bg-[#F3F0EB] flex items-center justify-center font-display font-bold text-[14px] text-ink shrink-0">
                    {app.mono}
                  </div>
                  <div className="min-w-0">
                    <div className="font-body font-semibold text-[14px] text-ink truncate">
                      {app.role}
                    </div>
                    <div className="font-body text-[12px] text-ink-light">
                      {app.co}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] tracking-[0.4px] uppercase text-ink-muted">
                    {app.when}
                  </span>
                  <span
                    className={`font-mono text-[9px] tracking-[0.5px] uppercase px-[7px] py-[3px] rounded ${
                      app.result === "Offer"
                        ? "text-green bg-green-bg"
                        : "text-ink-muted bg-[#F3F0EB]"
                    }`}
                  >
                    {app.result}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const nav = useVantage((s) => s.nav);

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-paper">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto h-screen">
        {nav === "chat" && <ChatView />}
        {nav === "today" && <TodayView />}
        {nav === "apps" && <TrackerView />}
      </main>
    </div>
  );
}
