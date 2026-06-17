import { create } from "zustand";
import {
  chat as chatApi,
  resumes as resumesApi,
  jobs as jobsApi,
  applications as applicationsApi,
  trends as trendsApi,
} from "./api";

export type Screen = "onboarding" | "app" | "review" | "extension" | "builder" | "mock";
export type Nav = "chat" | "today" | "apps";
export type ParseStage = "idle" | "parsing" | "done";
export type OnboardMethod = "upload" | "chat" | "paste" | "link";
export type MockState = "setup" | "live";
export type MockLevel = "warmup" | "standard" | "pressure";

export interface Job {
  id: string;
  mono: string;
  co: string;
  role: string;
  match: number;
  location: string;
  salary?: string;
  ready?: boolean;
  external?: boolean;
  domain?: string;
  slug?: string;
  whyShort?: string;
  whyBullets?: string[];
  resumeBullets?: string[];
  coverLetter?: string;
  qa?: { q: string; a: string }[];
}

export interface Applied {
  mono: string;
  co: string;
  role: string;
  when: string;
  isNew?: boolean;
}

export interface Interviewing {
  mono: string;
  co: string;
  role: string;
  stage: string;
  when: string;
  qs: { q: string; hint: string }[];
  brief: string;
}

export interface Outcome {
  mono: string;
  co: string;
  role: string;
  when: string;
  result: string;
}

export interface ChatEntry {
  id: string;
  phase: number;
  key: number;
}

export interface MockQ {
  q: string;
  chips: string[];
  sample: string;
  feedback: string;
}

export interface BuilderStage {
  text: string;
  agents?: { label: string; state: string }[];
  chips: string[];
}

export const JOBS: Job[] = [
  {
    id: "linear", mono: "L", co: "Linear", role: "Senior Product Designer", match: 96,
    location: "Remote", salary: "$180–210k", ready: true,
    whyBullets: [
      "7 years in product design — the role asks for 5+.",
      "Led design-systems work, a core responsibility here.",
      "Shipped 0→1 collaboration tools, matching their roadmap.",
    ],
    resumeBullets: [
      "Led the redesign of a real-time collaboration tool used by 40k teams.",
      "Built a design system that cut design-to-dev handoff time by 60%.",
      "7 years spanning 0→1 and scale-stage product design.",
    ],
    coverLetter: "Dear Linear team,\n\nI've spent seven years designing tools where speed and craft both matter — and Linear is the rare product that refuses to trade one for the other. I'd love to help shape what comes next.\n\nMy work on real-time collaboration at scale maps closely to the problems on your roadmap, and I move fast without losing the details.\n\nWarmly,\nJordan",
    qa: [
      { q: "Why are you interested in this role?", a: "Linear's focus on speed and craft mirrors how I already work — I want to build for a team that treats the tool itself as the product." },
      { q: "Expected compensation?", a: "$180–210k base, flexible for the right team and equity mix." },
    ],
  },
  {
    id: "ramp", mono: "R", co: "Ramp", role: "Staff Product Designer", match: 93,
    location: "NYC / Remote", salary: "$200–240k", ready: true,
    whyBullets: [
      "Staff-level scope matches your 7 years of leadership.",
      "Fintech-adjacent work on dashboards and data-dense UI.",
      "Strong track record mentoring designers.",
    ],
    resumeBullets: [
      "Owned the analytics surface for a 40k-team product.",
      "Mentored 4 designers from mid to senior.",
      "Drove a pricing-page redesign that lifted conversion 18%.",
    ],
    coverLetter: "Dear Ramp team,\n\nI build clarity into dense, high-stakes interfaces — exactly the challenge finance teams live with daily. I'd be excited to bring that to Ramp at staff level.\n\nWarmly,\nJordan",
    qa: [
      { q: "Why are you interested in this role?", a: "Ramp ships fast and respects design — a combination I want to operate inside at staff scope." },
      { q: "Expected compensation?", a: "$200–240k base, open on equity." },
    ],
  },
  {
    id: "vercel", mono: "V", co: "Vercel", role: "Design Lead", match: 91,
    location: "Remote", external: true,
    domain: "vercel", slug: "design-lead",
    whyShort: "Vercel sets the bar for developer experience, and I want to lead design where craft and performance are the product.",
  },
  {
    id: "notion", mono: "N", co: "Notion", role: "Senior UX Designer", match: 88,
    location: "San Francisco", salary: "$170–200k", ready: true,
    whyBullets: [
      "Deep experience designing flexible, content-first tools.",
      "Strong systems thinking for modular interfaces.",
      "Comfortable balancing power and simplicity.",
    ],
    resumeBullets: [
      "Designed a modular block-based editor used daily by 12k people.",
      "Simplified onboarding, cutting time-to-first-value by 40%.",
      "7 years across consumer and prosumer software.",
    ],
    coverLetter: "Dear Notion team,\n\nThe hardest design problem is making something powerful feel simple — it's the problem I most enjoy. Notion lives at that edge, and I'd love to help.\n\nWarmly,\nJordan",
    qa: [
      { q: "Why are you interested in this role?", a: "Notion balances power and simplicity better than almost anyone — that's the work I want to be doing." },
      { q: "Expected compensation?", a: "$170–200k base." },
    ],
  },
  {
    id: "stripe", mono: "S", co: "Stripe", role: "Product Designer", match: 84,
    location: "Remote", external: true,
    domain: "stripe", slug: "product-designer",
    whyShort: "Stripe treats documentation and detail as design surfaces — that obsessiveness is exactly how I work.",
  },
];

export const INTERVIEWING_DATA: Interviewing[] = [
  {
    mono: "St", co: "Stripe", role: "Product Designer", stage: "Recruiter screen", when: "Tomorrow · 2:00pm",
    qs: [
      { q: "Walk me through a project you're proud of.", hint: "Lead with the 40k-team collaboration redesign — name the metric (60% faster handoff) early." },
      { q: "How do you handle disagreement with engineering?", hint: "Show you treat constraints as design input, not obstacles. Give one concrete example." },
      { q: "Why Stripe?", hint: "Their docs-as-product philosophy — tie it to your obsession with detail." },
    ],
    brief: "Recruiter screen with Dana from Talent. 30 minutes, conversational. Stripe weighs craft and written communication heavily — expect a follow-up take-home, not a live exercise.",
  },
  {
    mono: "Rt", co: "Retool", role: "Senior Designer", stage: "Hiring manager", when: "Thu · 11:00am",
    qs: [
      { q: "How do you design for technical, power-user audiences?", hint: "Reference the analytics surface work — density without clutter." },
      { q: "What's your take on internal tools?", hint: "Frame them as leverage: small design wins compound across every team using them." },
      { q: "Where do you want to grow?", hint: "Be honest — pick one real edge (e.g. front-end fluency) and show momentum." },
    ],
    brief: "Hiring-manager round with the Head of Design. 45 minutes. Retool values pragmatism over polish — bring opinions about shipping fast.",
  },
];

export const OUTCOME_DATA: Outcome[] = [
  { mono: "L", co: "Linear", role: "Design Lead", when: "1w ago", result: "Offer" },
  { mono: "W", co: "Webflow", role: "Product Designer", when: "2w ago", result: "Closed" },
];

export const BUILDER_STAGES: BuilderStage[] = [
  {
    text: "I've read your résumé, Jordan — strong material to work with. Before I tailor anything, let's get your positioning sharp. First: are you aiming to stay a senior individual contributor, or step toward lead / staff?",
    agents: [{ label: "Résumé parser", state: "done" }, { label: "Skill extractor", state: "done" }],
    chips: ["Senior IC", "Lead / Staff", "Open to both"],
  },
  {
    text: "Good. I'll lead with scope and ownership. Now the spine — what's the one project you're proudest of? I'll build the résumé around it.",
    chips: ["The 40k-team collab redesign", "The design-system overhaul"],
  },
  {
    text: "On it — rewriting your top bullets to lead with outcomes instead of tasks. One call: keep your understated tone, or sharpen the language?",
    agents: [{ label: "Impact writer", state: "done" }, { label: "Metric finder", state: "done" }],
    chips: ["Keep my tone", "Sharpen it"],
  },
  {
    text: "Done. I reordered for impact, quantified what I could, and tightened every line. Your profile on the right is what I'll tailor against every role from now on.",
    agents: [{ label: "Profile compiler", state: "done" }],
    chips: [],
  },
];

export const MOCK_QS: MockQ[] = [
  {
    q: "Thanks for making the time. To start — walk me through a project you're genuinely proud of.",
    chips: ["Lead with the 40k-team collab redesign + the 60% metric", "Start from the user problem, then the outcome"],
    sample: "I led the real-time collaboration redesign used by 40k teams — cut handoff time 60%.",
    feedback: "Strong open. You led with the metric early — exactly right. Next time, name the user problem in one sentence before the solution.",
  },
  {
    q: "How do you handle disagreement with engineering when timelines are tight?",
    chips: ["Treat constraints as design input, give a concrete example", "Show how I de-risk with a smaller first cut"],
    sample: "I treat constraints as input — once, eng pushed back on a flow, so we shipped a smaller cut first and measured.",
    feedback: "Good — you framed constraints as input, not obstacles. The concrete example landed. Tighten it: one situation, one decision, one result.",
  },
  {
    q: "Why Stripe, specifically?",
    chips: ["Tie their docs-as-product philosophy to my obsession with detail", "Connect it to the role, not just the brand"],
    sample: "Stripe treats documentation and detail as design surfaces — that obsessiveness is how I already work.",
    feedback: "That's the right instinct — you connected their philosophy to how you work, not just praise. Specific and credible.",
  },
  {
    q: "Tell me about a time a design of yours failed. What happened?",
    chips: ["Own it plainly, then show what you changed", "Pick a real miss with a measurable correction"],
    sample: "An onboarding flow I shipped tanked activation 8%. I owned it, ran the research I skipped, and recovered it +40%.",
    feedback: "Excellent — you owned it without hedging and showed the correction with a number. That honesty reads as senior.",
  },
  {
    q: "Where do you want to grow over the next two years?",
    chips: ["Name one real edge and show momentum", "Tie growth to the role, not just generic ambition"],
    sample: "Front-end fluency — I've been shipping small PRs so I can prototype in code, not just Figma.",
    feedback: "Well judged. A real edge plus visible momentum beats a polished non-answer every time. You're ready for the room.",
  },
];

export const MOCK_PROGRESS_LABELS = ["Proudest project", "Disagreement with eng", "Why Stripe", "A failure", "Growth areas"];

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  agent?: string;
}

export interface ApiJob {
  id: string;
  company: string;
  role_title: string;
  url: string;
  parsed: { skills?: string[]; level?: string; salary_min?: number; salary_max?: number; locations?: string[]; remote?: boolean };
  posted_date: string;
  matchScore?: number;
  matchedSkills?: string[];
  missingSkills?: string[];
}

export interface ApiApplication {
  id: string;
  status: string;
  company: string;
  role_title: string;
  cover_letter?: string;
  submitted_at?: string;
  created_at: string;
}

export interface TrendSnapshot {
  totalJobs: number;
  newJobsThisWeek: number;
  topSkills: { skill: string; count: number }[];
  topRoles: { role_title: string; count: number }[];
}

interface VantageState {
  screen: Screen;
  parseStage: ParseStage;
  onboardMethod: OnboardMethod;
  nav: Nav;
  activeId: string;
  prepId: number | null;
  eFilled: boolean;
  builderStep: number;
  builderTarget: string | null;
  builderThinking: boolean;
  builderChoices: string[];
  mockState: MockState;
  mockLevel: MockLevel;
  mockAnswers: string[];
  pendingAnswer: string | null;
  mockThinking: boolean;
  chatLog: ChatEntry[];
  chatInput: string;
  chatMessages: ChatMessage[];
  chatSessionId: string | null;
  chatLoading: boolean;
  applied: Applied[];

  apiJobs: ApiJob[];
  apiJobsLoading: boolean;
  apiApplications: ApiApplication[];
  apiAppsLoading: boolean;
  trendSnapshot: TrendSnapshot | null;
  currentResumeId: string | null;

  setScreen: (s: Screen) => void;
  setParseStage: (s: ParseStage) => void;
  setOnboardMethod: (m: OnboardMethod) => void;
  setNav: (n: Nav) => void;
  startParse: () => void;
  enterApp: () => void;
  goChat: () => void;
  goToday: () => void;
  goTracker: () => void;
  goInterviews: () => void;
  openReview: (id: string) => void;
  backHome: () => void;
  submitReview: () => void;
  openExtension: (id: string) => void;
  closeExt: () => void;
  extSubmit: () => void;
  openPrep: (i: number) => void;
  closePrep: () => void;
  goBuilder: () => void;
  advanceBuilder: (choice: string) => void;
  sendBuilder: () => void;
  goMockSetup: () => void;
  setMockLevel: (lv: MockLevel) => void;
  startMock: () => void;
  restartMock: () => void;
  answerMock: (label: string) => void;
  sendMock: () => void;
  mockFromPrep: () => void;
  startByChat: () => void;
  runFlow: (id: string) => void;
  sendChat: () => void;
  setChatInput: (v: string) => void;
  sendRealChat: () => void;
  createResume: (content: object) => Promise<void>;
  loadJobs: () => Promise<void>;
  loadApplications: () => Promise<void>;
  loadTrends: () => Promise<void>;
  submitApplication: (jobId: string) => Promise<void>;
}

export const useVantage = create<VantageState>((set, get) => ({
  screen: "onboarding",
  parseStage: "idle",
  onboardMethod: "upload",
  nav: "chat",
  activeId: "linear",
  prepId: null,
  eFilled: false,
  builderStep: 0,
  builderTarget: null,
  builderThinking: false,
  builderChoices: [],
  mockState: "setup",
  mockLevel: "standard",
  mockAnswers: [],
  pendingAnswer: null,
  mockThinking: false,
  chatLog: [],
  chatInput: "",
  chatMessages: [],
  chatSessionId: null,
  chatLoading: false,
  applied: [
    { mono: "Fg", co: "Figma", role: "Product Designer", when: "2d ago" },
    { mono: "Ab", co: "Airbnb", role: "Senior Product Designer", when: "4d ago" },
  ],

  apiJobs: [],
  apiJobsLoading: false,
  apiApplications: [],
  apiAppsLoading: false,
  trendSnapshot: null,
  currentResumeId: null,

  setScreen: (s) => set({ screen: s }),
  setParseStage: (s) => set({ parseStage: s }),
  setOnboardMethod: (m) => set({ onboardMethod: m }),
  setNav: (n) => set({ nav: n }),

  startParse: () => {
    set({ parseStage: "parsing" });
    setTimeout(() => set({ parseStage: "done" }), 2100);
  },

  enterApp: () => {
    set({ screen: "app", nav: "chat" });
    get().loadJobs();
    get().loadTrends();
    get().createResume({
      basics: {
        name: "Jordan Avery",
        label: "Senior Product Designer",
        email: "jordan@example.com",
        location: { city: "San Francisco", region: "CA" },
        summary: "Senior Product Designer with 7 years of experience designing tools where speed and craft both matter.",
      },
      skills: [
        { name: "Design Systems", level: "Expert" },
        { name: "User Research", level: "Advanced" },
        { name: "Prototyping", level: "Expert" },
        { name: "Accessibility", level: "Advanced" },
        { name: "Design Leadership", level: "Advanced" },
        { name: "Figma", level: "Expert" },
        { name: "React", level: "Intermediate" },
        { name: "CSS", level: "Advanced" },
      ],
      work: [
        {
          company: "Previous Company",
          position: "Senior Product Designer",
          startDate: "2020-01",
          summary: "Led the redesign of a real-time collaboration tool used by 40k teams. Built a design system that cut design-to-dev handoff time by 60%.",
        },
      ],
    });
  },
  startByChat: () => set({ screen: "builder" }),
  goChat: () => set({ screen: "app", nav: "chat" }),
  goToday: () => set({ screen: "app", nav: "today" }),
  goTracker: () => set({ screen: "app", nav: "apps" }),
  goInterviews: () => {
    set({ screen: "app", nav: "apps" });
    setTimeout(() => set({ prepId: 0 }), 60);
  },

  openReview: (id) => set({ screen: "review", activeId: id }),
  backHome: () => set({ screen: "app", nav: "today" }),

  submitReview: () => {
    const s = get();
    const demoJob = JOBS.find((x) => x.id === s.activeId);
    const apiJob = s.apiJobs.find((x) => x.id === s.activeId);
    const co = demoJob?.co || apiJob?.company || "Unknown";
    const role = demoJob?.role || apiJob?.role_title || "Unknown";
    const mono = demoJob?.mono || co.charAt(0).toUpperCase();

    if (apiJob) {
      get().submitApplication(apiJob.id);
    }

    const already = s.applied.some((a) => a.co === co && a.isNew);
    if (!already) {
      set({
        applied: [
          { mono, co, role, when: "Just now", isNew: true },
          ...s.applied.map((a) => ({ ...a, isNew: false })),
        ],
      });
    }
    set({ screen: "app", nav: "apps" });
    get().loadApplications();
  },

  openExtension: (id) => {
    set({ screen: "extension", activeId: id, eFilled: false });
    setTimeout(() => set({ eFilled: true }), 1300);
  },

  closeExt: () => set({ screen: "app", nav: "today" }),

  extSubmit: () => {
    const s = get();
    const demoJob = JOBS.find((x) => x.id === s.activeId);
    const apiJob = s.apiJobs.find((x) => x.id === s.activeId);
    const co = demoJob?.co || apiJob?.company || "Unknown";
    const role = demoJob?.role || apiJob?.role_title || "Unknown";
    const mono = demoJob?.mono || co.charAt(0).toUpperCase();

    if (apiJob) {
      get().submitApplication(apiJob.id);
    }

    const already = s.applied.some((a) => a.co === co && a.isNew);
    if (!already) {
      set({
        applied: [
          { mono, co, role, when: "Just now", isNew: true },
          ...s.applied.map((a) => ({ ...a, isNew: false })),
        ],
      });
    }
    set({ screen: "app", nav: "apps" });
    get().loadApplications();
  },

  openPrep: (i) => set({ prepId: i }),
  closePrep: () => set({ prepId: null }),

  goBuilder: () => set({ screen: "builder" }),

  advanceBuilder: (choice) => {
    const s = get();
    if (s.builderStep === 0) {
      set({ builderTarget: choice, builderThinking: true });
    } else {
      set({ builderThinking: true });
    }
    setTimeout(() => {
      const cur = get();
      set({
        builderChoices: [...cur.builderChoices, choice],
        builderStep: Math.min(cur.builderStep + 1, BUILDER_STAGES.length - 1),
        builderThinking: false,
      });
    }, 750);
  },

  sendBuilder: () => {
    const s = get();
    const stage = BUILDER_STAGES[s.builderStep];
    const c = stage?.chips?.[0];
    if (c) get().advanceBuilder(c);
  },

  goMockSetup: () => set({ screen: "mock", mockState: "setup" }),
  setMockLevel: (lv) => set({ mockLevel: lv }),
  startMock: () => set({ mockState: "live", mockAnswers: [], pendingAnswer: null, mockThinking: false }),
  restartMock: () => set({ mockAnswers: [], pendingAnswer: null, mockThinking: false }),

  answerMock: (label) => {
    if (get().pendingAnswer != null) return;
    set({ pendingAnswer: label, mockThinking: true });
    setTimeout(() => {
      const cur = get();
      set({
        mockAnswers: [...cur.mockAnswers, label],
        pendingAnswer: null,
        mockThinking: false,
      });
    }, 900);
  },

  sendMock: () => {
    const s = get();
    const q = MOCK_QS[s.mockAnswers.length];
    if (q) get().answerMock(q.sample);
  },

  mockFromPrep: () => set({ prepId: null, screen: "mock", mockState: "setup", mockAnswers: [], pendingAnswer: null }),

  runFlow: (id) => {
    const key = Date.now() + Math.random();
    set((s) => ({
      screen: "app",
      nav: "chat",
      chatLog: [...s.chatLog, { id, phase: 0, key }],
    }));
    setTimeout(() => {
      set((s) => ({
        chatLog: s.chatLog.map((c) => (c.key === key ? { ...c, phase: 1 } : c)),
      }));
    }, 1500);
  },

  sendChat: () => get().runFlow("find"),

  setChatInput: (v) => set({ chatInput: v }),

  sendRealChat: async () => {
    const s = get();
    const msg = s.chatInput.trim();
    if (!msg || s.chatLoading) return;
    set({
      chatInput: "",
      chatLoading: true,
      chatMessages: [...s.chatMessages, { role: "user", content: msg }],
    });
    try {
      const res = await chatApi.send(msg, s.chatSessionId || undefined);
      set((prev) => ({
        chatSessionId: res.sessionId,
        chatMessages: [...prev.chatMessages, { role: "assistant", content: res.reply.content, agent: res.reply.metadata.agent }],
        chatLoading: false,
      }));
    } catch {
      set((prev) => ({
        chatMessages: [...prev.chatMessages, { role: "assistant", content: "Sorry, I couldn't process that request. Please try again." }],
        chatLoading: false,
      }));
    }
  },

  createResume: async (content) => {
    try {
      const res = await resumesApi.create(content, true);
      set({ currentResumeId: res.resume.id });
    } catch {
      // silently fail for MVP — resume still shows in local state
    }
  },

  loadJobs: async () => {
    set({ apiJobsLoading: true });
    try {
      const res = await jobsApi.list({ limit: 20 });
      const jobsWithScores = await Promise.all(
        res.jobs.map(async (j) => {
          try {
            const m = await jobsApi.match(j.id);
            return { ...j, matchScore: m.match.score, matchedSkills: m.match.matchedSkills, missingSkills: m.match.missingSkills };
          } catch {
            return { ...j, matchScore: 50 };
          }
        }),
      );
      jobsWithScores.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
      set({ apiJobs: jobsWithScores, apiJobsLoading: false });
    } catch {
      set({ apiJobsLoading: false });
    }
  },

  loadApplications: async () => {
    set({ apiAppsLoading: true });
    try {
      const res = await applicationsApi.list();
      set({ apiApplications: res.applications as ApiApplication[], apiAppsLoading: false });
    } catch {
      set({ apiAppsLoading: false });
    }
  },

  loadTrends: async () => {
    try {
      const res = await trendsApi.today();
      set({ trendSnapshot: res.snapshot });
    } catch {
      // keep null
    }
  },

  submitApplication: async (jobId) => {
    const s = get();
    const resumeId = s.currentResumeId;
    try {
      await applicationsApi.prepare(jobId, resumeId || "", undefined);
    } catch {
      // silently fail for MVP
    }
  },
}));
