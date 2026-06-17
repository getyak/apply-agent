import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

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
  if (sessionCheck.rows.length === 0) return c.json({ error: "Session not found" }, 404);

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

  let sid = sessionId;
  if (!sid) {
    const sessionResult = await query(
      `INSERT INTO conversation_sessions (user_id, title, session_type, agent_type, created_at)
       VALUES ($1, $2, 'general', 'coordinator', NOW()) RETURNING id`,
      [userId, message.slice(0, 50)],
    );
    sid = sessionResult.rows[0].id;
  }

  await query(
    `INSERT INTO conversation_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW())`,
    [sid, message],
  );

  const assistantReply = generateAssistantReply(message);

  await query(
    `INSERT INTO conversation_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW())`,
    [sid, assistantReply.content, JSON.stringify(assistantReply.metadata)],
  );

  return c.json({
    sessionId: sid,
    reply: assistantReply,
  });
});

function generateAssistantReply(message: string): { content: string; metadata: { agent: string } } {
  const lower = message.toLowerCase();

  if (lower.includes("resume") || lower.includes("简历")) {
    return {
      content: "I can help you with your resume! Here are some options:\n\n1. **Upload a new resume** — I'll parse it into a structured format\n2. **Optimize your current resume** — I'll suggest improvements\n3. **Tailor for a specific job** — Paste a job description and I'll customize\n\nWhat would you like to do?",
      metadata: { agent: "resume_agent" },
    };
  }

  if (lower.includes("job") || lower.includes("match") || lower.includes("职位")) {
    return {
      content: "Let me help you find matching jobs! I've analyzed your profile and found several strong matches. Check the **Today** tab for your personalized job feed, or tell me specific preferences (role, location, remote, salary range) and I'll narrow it down.",
      metadata: { agent: "jobmatch_agent" },
    };
  }

  if (lower.includes("interview") || lower.includes("面试")) {
    return {
      content: "I'd love to help you prepare for interviews! You can:\n\n1. **Start a mock interview** — Choose a job and I'll generate relevant questions\n2. **Review past sessions** — See your progress and areas to improve\n3. **Get company insights** — I'll share what to expect\n\nHead to **AI Studio → Mock Interview** or tell me which company you're preparing for.",
      metadata: { agent: "interview_agent" },
    };
  }

  if (lower.includes("apply") || lower.includes("投递") || lower.includes("application")) {
    return {
      content: "Ready to apply! Here's how it works:\n\n1. I'll prepare a **tailored resume** + **cover letter** for the position\n2. Generate answers for common application questions\n3. You review everything, then submit through the browser extension\n\nWhich job would you like to apply to?",
      metadata: { agent: "appprep_agent" },
    };
  }

  return {
    content: "I'm Vantage, your AI job-search copilot. I can help you with:\n\n- **Resume management** — Upload, optimize, and tailor your resume\n- **Job matching** — Find roles that fit your skills\n- **Interview prep** — Practice with AI-generated questions\n- **Applications** — Prepare tailored application packages\n\nWhat would you like to work on?",
    metadata: { agent: "coordinator" },
  };
}

export default app;
