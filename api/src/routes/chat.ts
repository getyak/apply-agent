import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { llm, LLMUnavailableError, type ChatMessage } from "../llm";
import { NotFoundError, ValidationError } from "../errors";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

// The coordinator's job: classify which specialist the user needs AND produce a
// genuinely helpful reply in one LLM call. This replaces the old keyword switch
// that returned canned menu text regardless of what the user actually asked.

const AGENTS = [
  "resume_agent",
  "jobmatch_agent",
  "interview_agent",
  "appprep_agent",
  "coordinator",
] as const;
type AgentName = (typeof AGENTS)[number];

const SYSTEM_PROMPT =
  "You are Vantage, an AI job-search copilot. You coordinate five specialists: " +
  "resume_agent (parse/optimize/tailor resumes), jobmatch_agent (find & score jobs), " +
  "interview_agent (mock interviews & feedback), appprep_agent (cover letters, application packages), " +
  "and coordinator (general help). " +
  "Read the user's latest message in context and respond helpfully and concretely — " +
  "do not just list generic menus. " +
  'Return JSON: {"agent": one of ["resume_agent","jobmatch_agent","interview_agent","appprep_agent","coordinator"], "reply": string}. ' +
  "Pick the agent whose domain best matches the request. Keep the reply focused and actionable. " +
  "Never fabricate user data; if you lack info, ask a specific follow-up question.";

const MAX_HISTORY = 10;

interface CoordinatorOutput {
  agent: AgentName;
  reply: string;
}

/**
 * Route + reply via the LLM. On unavailability, fall back to the old
 * keyword-based reply so chat keeps working without a key.
 */
async function coordinate(
  history: ChatMessage[],
  message: string,
): Promise<{
  content: string;
  agent: AgentName;
  degraded: boolean;
  tokens: number;
  costCents: number;
}> {
  if (!llm.available) {
    const fb = fallbackReply(message);
    return { content: fb.content, agent: fb.agent, degraded: true, tokens: 0, costCents: 0 };
  }

  try {
    const { data, meta } = await llm.chatJSON<CoordinatorOutput>(
      [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: message },
      ],
      { tier: "general", temperature: 0.6, maxTokens: 900 },
    );

    const agent: AgentName = AGENTS.includes(data.agent) ? data.agent : "coordinator";
    const replyOk = typeof data.reply === "string" && data.reply.trim().length > 0;
    if (!replyOk) {
      console.warn("[chat] LLM returned empty reply; data=", JSON.stringify(data).slice(0, 200));
    }
    const content = replyOk ? data.reply.trim() : fallbackReply(message).content;
    const tokens = meta.usage.promptTokens + meta.usage.completionTokens;
    return { content, agent, degraded: false, tokens, costCents: meta.costCents };
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      console.warn("[chat] LLMUnavailableError:", (err as Error).message);
      const fb = fallbackReply(message);
      return { content: fb.content, agent: fb.agent, degraded: true, tokens: 0, costCents: 0 };
    }
    throw err;
  }
}

/** Deterministic keyword reply — used only when the LLM is unavailable. */
function fallbackReply(message: string): { content: string; agent: AgentName } {
  const lower = message.toLowerCase();
  if (lower.includes("resume") || lower.includes("简历")) {
    return { content: "I can help with your resume — upload a new one, optimize the current one, or tailor it to a specific job. Which would you like?", agent: "resume_agent" };
  }
  if (lower.includes("job") || lower.includes("match") || lower.includes("职位")) {
    return { content: "Let me help you find matching jobs. Tell me your target role, location, remote preference, and salary range, and I'll narrow it down.", agent: "jobmatch_agent" };
  }
  if (lower.includes("interview") || lower.includes("面试")) {
    return { content: "I can run a mock interview tailored to a role. Pick a job (or paste a JD) and I'll generate relevant questions and give feedback on your answers.", agent: "interview_agent" };
  }
  if (lower.includes("apply") || lower.includes("投递") || lower.includes("application")) {
    return { content: "I'll prepare a tailored resume + cover letter + application answers for review. Which job would you like to apply to?", agent: "appprep_agent" };
  }
  return { content: "I'm Vantage, your AI job-search copilot. I can help with resumes, job matching, interview prep, and applications. What would you like to work on?", agent: "coordinator" };
}

app.post("/sessions", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { title } = body;

  const result = await query(
    `INSERT INTO conversation_sessions (user_id, title, session_type, agent_type, created_at)
     VALUES ($1, $2, 'general', 'coordinator', NOW())
     RETURNING *`,
    [userId, title || "New conversation"],
  );
  return c.json({ session: result.rows[0] }, 201);
});

app.get("/sessions", async (c) => {
  const userId = c.get("userId");
  const result = await query(
    "SELECT * FROM conversation_sessions WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
  return c.json({ sessions: result.rows });
});

app.get("/sessions/:id/messages", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");

  const sessionCheck = await query(
    "SELECT id FROM conversation_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (sessionCheck.rows.length === 0) throw new NotFoundError("Session not found");

  const result = await query(
    "SELECT * FROM conversation_messages WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId],
  );
  return c.json({ messages: result.rows });
});

app.post("/send", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { sessionId, message } = body;

  if (typeof message !== "string" || message.trim().length === 0) {
    throw new ValidationError("message is required");
  }

  let sid = sessionId;
  if (sid) {
    // Ownership check on an existing session before writing to it.
    const own = await query(
      "SELECT id FROM conversation_sessions WHERE id = $1 AND user_id = $2",
      [sid, userId],
    );
    if (own.rows.length === 0) throw new NotFoundError("Session not found");
  } else {
    const sessionResult = await query(
      `INSERT INTO conversation_sessions (user_id, title, session_type, agent_type, created_at)
       VALUES ($1, $2, 'general', 'coordinator', NOW()) RETURNING id`,
      [userId, message.slice(0, 50)],
    );
    sid = sessionResult.rows[0].id;
  }

  // Load recent history so the coordinator has conversational context.
  const historyRows = await query(
    "SELECT role, content FROM conversation_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2",
    [sid, MAX_HISTORY],
  );
  const history: ChatMessage[] = historyRows.rows
    .reverse()
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  await query(
    `INSERT INTO conversation_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW())`,
    [sid, message],
  );

  const { content, agent, degraded, tokens, costCents } = await coordinate(history, message);

  await query(
    `INSERT INTO conversation_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW())`,
    [sid, content, JSON.stringify({ agent, aiGenerated: !degraded })],
  );

  // Keep the session's rollup counters current — message_count grows by 2
  // (user + assistant), and token/cost accumulate from the LLM usage meta.
  // Migration 007 defines these columns; without this they'd stay at 0.
  await query(
    `UPDATE conversation_sessions
        SET last_active_at = NOW(),
            message_count = message_count + 2,
            total_tokens = total_tokens + $2,
            total_cost_cents = total_cost_cents + $3
      WHERE id = $1`,
    [sid, tokens, costCents],
  );

  return c.json({
    sessionId: sid,
    reply: { content, metadata: { agent, aiGenerated: !degraded } },
  });
});

export default app;
