"use client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("vantage_token");
}

export function setToken(token: string) {
  localStorage.setItem("vantage_token", token);
}

export function clearToken() {
  localStorage.removeItem("vantage_token");
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || "Request failed");
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const auth = {
  register: (email: string, password: string, displayName?: string) =>
    api<{ token: string; user: { id: string; email: string; display_name: string } }>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, displayName }) },
    ),

  login: (email: string, password: string) =>
    api<{ token: string; user: { id: string; email: string; display_name: string } }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
    ),

  me: () =>
    api<{ user: { id: string; email: string; display_name: string; preferences: unknown } }>(
      "/api/auth/me",
    ),
};

export const resumes = {
  create: (content: object, isBase = true) =>
    api<{ resume: { id: string; version: number; content: object } }>(
      "/api/resumes",
      { method: "POST", body: JSON.stringify({ content, isBase }) },
    ),

  list: () =>
    api<{ resumes: Array<{ id: string; version: number; is_base: boolean; created_at: string }> }>(
      "/api/resumes",
    ),

  get: (id: string) =>
    api<{ resume: { id: string; content: object; version: number } }>(
      `/api/resumes/${id}`,
    ),
};

export const jobs = {
  list: (params?: { search?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return api<{ jobs: Array<{ id: string; company: string; role_title: string; url: string; parsed: object; posted_date: string }> }>(
      `/api/jobs${query ? `?${query}` : ""}`,
    );
  },

  get: (id: string) =>
    api<{ job: { id: string; company: string; role_title: string; jd_text: string; parsed: object } }>(
      `/api/jobs/${id}`,
    ),

  match: (jobId: string) =>
    api<{ match: { score: number; matchedSkills: string[]; missingSkills: string[] } }>(
      `/api/jobs/${jobId}/match`,
      { method: "POST" },
    ),
};

export const applications = {
  prepare: (jobId: string, resumeId: string, coverLetter?: string) =>
    api<{ application: { id: string; status: string } }>(
      "/api/applications/prepare",
      { method: "POST", body: JSON.stringify({ jobId, resumeId, coverLetter }) },
    ),

  list: (status?: string) => {
    const qs = status ? `?status=${status}` : "";
    return api<{ applications: Array<{ id: string; status: string; company: string; role_title: string }> }>(
      `/api/applications${qs}`,
    );
  },

  update: (id: string, data: { status?: string; outcome?: string; coverLetter?: string }) =>
    api<{ application: { id: string; status: string } }>(
      `/api/applications/${id}`,
      { method: "PATCH", body: JSON.stringify(data) },
    ),
};

export const interviews = {
  createSession: (jobId?: string) =>
    api<{ session: { id: string }; questions: Array<{ id: string; question_text: string; category: string }> }>(
      "/api/interviews/session",
      { method: "POST", body: JSON.stringify({ jobId }) },
    ),

  answer: (sessionId: string, questionId: string, answer: string) =>
    api<{ question: object; feedback: { text: string; rating: number } }>(
      `/api/interviews/${sessionId}/answer`,
      { method: "POST", body: JSON.stringify({ questionId, answer }) },
    ),

  list: () =>
    api<{ sessions: Array<{ id: string; company: string; role_title: string; created_at: string }> }>(
      "/api/interviews",
    ),
};

export const chat = {
  send: (message: string, sessionId?: string) =>
    api<{ sessionId: string; reply: { content: string; metadata: { agent: string } } }>(
      "/api/chat/send",
      { method: "POST", body: JSON.stringify({ sessionId, message }) },
    ),

  sessions: () =>
    api<{ sessions: Array<{ id: string; title: string; created_at: string }> }>(
      "/api/chat/sessions",
    ),

  messages: (sessionId: string) =>
    api<{ messages: Array<{ id: string; role: string; content: string; created_at: string }> }>(
      `/api/chat/sessions/${sessionId}/messages`,
    ),
};

export const trends = {
  today: () =>
    api<{ snapshot: { totalJobs: number; newJobsThisWeek: number; topSkills: Array<{ skill: string; count: number }>; topRoles: Array<{ role_title: string; count: number }> } }>(
      "/api/trends/today",
    ),

  personalized: () =>
    api<{ personalized: { yourSkills: string[]; trendingSkills: string[]; youHave: string[]; youNeed: string[]; insight: string } }>(
      "/api/trends/personalized",
    ),
};
