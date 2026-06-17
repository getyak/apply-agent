import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

const SAMPLE_QUESTIONS: { text: string; category: string }[] = [
  { text: "Tell me about a time you had to make a difficult technical decision. What was the context, and how did you approach it?", category: "behavioral" },
  { text: "How would you design a system that handles 10,000 concurrent users with sub-200ms response times?", category: "technical" },
  { text: "Walk me through your experience with the technology stack listed in this role.", category: "technical" },
  { text: "Describe a situation where you had a conflict with a team member. How did you resolve it?", category: "behavioral" },
  { text: "If you joined our team and discovered the codebase had significant technical debt, how would you prioritize addressing it?", category: "situational" },
];

app.post("/session", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { jobId } = body;

  const sessionResult = await query(
    `INSERT INTO interview_sessions (user_id, job_id, interview_type, total_questions, created_at)
     VALUES ($1, $2, 'mock', $3, NOW())
     RETURNING id, user_id, job_id, interview_type, total_questions, created_at`,
    [userId, jobId || null, SAMPLE_QUESTIONS.length],
  );
  const session = sessionResult.rows[0];

  for (let i = 0; i < SAMPLE_QUESTIONS.length; i++) {
    const q = SAMPLE_QUESTIONS[i];
    await query(
      `INSERT INTO interview_questions (session_id, question_order, question_text, category, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [session.id, i + 1, q.text, q.category],
    );
  }

  const questions = await query(
    "SELECT id, question_order, question_text, category FROM interview_questions WHERE session_id = $1 ORDER BY question_order",
    [session.id],
  );

  return c.json({ session, questions: questions.rows }, 201);
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  const result = await query(
    `SELECT s.*, j.company, j.role_title
     FROM interview_sessions s
     LEFT JOIN jobs j ON s.job_id = j.id
     WHERE s.user_id = $1
     ORDER BY s.created_at DESC`,
    [userId],
  );
  return c.json({ sessions: result.rows });
});

app.get("/:sessionId/questions", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const sessionCheck = await query(
    "SELECT id FROM interview_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (sessionCheck.rows.length === 0) return c.json({ error: "Session not found" }, 404);

  const result = await query(
    "SELECT * FROM interview_questions WHERE session_id = $1 ORDER BY question_order",
    [sessionId],
  );
  return c.json({ questions: result.rows });
});

app.post("/:sessionId/answer", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json();
  const { questionId, answer } = body;

  const sessionCheck = await query(
    "SELECT id FROM interview_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (sessionCheck.rows.length === 0) return c.json({ error: "Session not found" }, 404);

  const feedback = generateFeedback(answer);

  const result = await query(
    `UPDATE interview_questions
     SET user_answer = $1, ai_feedback = $2, ai_rating = $3
     WHERE id = $4 AND session_id = $5
     RETURNING *`,
    [answer, feedback.text, feedback.rating, questionId, sessionId],
  );
  if (result.rows.length === 0) return c.json({ error: "Question not found" }, 404);
  return c.json({ question: result.rows[0], feedback });
});

function generateFeedback(answer: string): { text: string; rating: number } {
  const wordCount = answer.trim().split(/\s+/).length;
  if (wordCount < 20) {
    return { text: "Your answer is quite brief. Try using the STAR method (Situation, Task, Action, Result) to provide more structure and detail.", rating: 2 };
  }
  if (wordCount < 50) {
    return { text: "Good start! Consider adding specific metrics or outcomes to strengthen your response. Quantifiable results make answers more compelling.", rating: 3 };
  }
  if (wordCount < 100) {
    return { text: "Solid response with good detail. To make it even stronger, ensure you clearly articulate the impact of your actions and any lessons learned.", rating: 4 };
  }
  return { text: "Excellent, thorough response! You've provided strong detail and context. Just make sure to stay focused on the most relevant points during a real interview to respect time constraints.", rating: 5 };
}

export default app;
