import { Hono } from "hono";
import { query, withTransaction } from "../db";
import { authMiddleware } from "../middleware/auth";
import { llm, LLMUnavailableError } from "../llm";
import { NotFoundError, ValidationError } from "../errors";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

const NUM_QUESTIONS = 10;

// Deterministic fallback used only when the LLM is unavailable (no key /
// upstream down). Kept intentionally generic and clearly marked so a degraded
// session is still usable — but the real value is the AI path below.
const FALLBACK_QUESTIONS: { text: string; category: string }[] = [
  { text: "Tell me about a time you had to make a difficult technical decision. What was the context, and how did you approach it?", category: "behavioral" },
  { text: "How would you design a system that handles 10,000 concurrent users with sub-200ms response times?", category: "technical" },
  { text: "Walk me through your experience with the technology stack listed in this role.", category: "technical" },
  { text: "Describe a situation where you had a conflict with a team member. How did you resolve it?", category: "behavioral" },
  { text: "If you joined our team and discovered the codebase had significant technical debt, how would you prioritize addressing it?", category: "situational" },
];

interface GeneratedQuestion {
  text: string;
  category: "technical" | "behavioral" | "situational";
}

/**
 * Generate JD-relevant interview questions via the LLM. Returns the AI set on
 * success, or the deterministic fallback (with a `degraded` flag) when the LLM
 * is unavailable. Never throws on LLM failure — a degraded session beats a 500.
 */
async function generateQuestions(job: {
  company: string | null;
  role_title: string | null;
  jd_text: string | null;
} | null): Promise<{
  questions: { text: string; category: string }[];
  degraded: boolean;
}> {
  if (!llm.available) {
    return { questions: FALLBACK_QUESTIONS, degraded: true };
  }

  const context = job
    ? `Company: ${job.company ?? "unknown"}\nRole: ${job.role_title ?? "unknown"}\nJob description:\n${(job.jd_text ?? "").slice(0, 4000)}`
    : "No specific job was provided; generate questions for a general software engineering role.";

  try {
    const { data } = await llm.chatJSON<{ questions: GeneratedQuestion[] }>(
      [
        {
          role: "system",
          content:
            "You are an expert technical interviewer. Generate realistic interview questions tailored to the role and job description. " +
            `Return JSON: {"questions":[{"text":string,"category":"technical"|"behavioral"|"situational"}]}. ` +
            `Produce exactly ${NUM_QUESTIONS} questions with a balanced mix of categories. Questions must be specific to the role, not generic.`,
        },
        { role: "user", content: context },
      ],
      { tier: "general", temperature: 0.8, maxTokens: 1500 },
    );

    const questions = (data.questions ?? [])
      .filter((q) => q && typeof q.text === "string" && q.text.trim().length > 0)
      .slice(0, NUM_QUESTIONS)
      .map((q) => ({
        text: q.text.trim(),
        category: ["technical", "behavioral", "situational"].includes(q.category)
          ? q.category
          : "behavioral",
      }));

    if (questions.length === 0) {
      return { questions: FALLBACK_QUESTIONS, degraded: true };
    }
    return { questions, degraded: false };
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      return { questions: FALLBACK_QUESTIONS, degraded: true };
    }
    throw err;
  }
}

interface Evaluation {
  rating: number; // 1-5
  text: string;
  strengths?: string[];
  improvements?: string[];
}

/**
 * Evaluate a candidate's answer against the question using the heavy-reasoning
 * model. Falls back to a neutral, length-aware heuristic only when the LLM is
 * unavailable so the endpoint never 500s on a degraded LLM.
 */
async function evaluateAnswer(
  questionText: string,
  category: string,
  answer: string,
): Promise<{ evaluation: Evaluation; degraded: boolean }> {
  if (!llm.available) {
    return { evaluation: heuristicEvaluation(answer), degraded: true };
  }

  try {
    const { data } = await llm.chatJSON<Evaluation>(
      [
        {
          role: "system",
          content:
            "You are a senior interviewer giving constructive, honest feedback on an interview answer. " +
            'Return JSON: {"rating":1-5,"text":string,"strengths":string[],"improvements":string[]}. ' +
            "Rate 1 (poor) to 5 (excellent) based on relevance, specificity, structure (e.g. STAR for behavioral), and depth. " +
            "Feedback must reference the actual content of the answer, not be generic.",
        },
        {
          role: "user",
          content: `Question (${category}): ${questionText}\n\nCandidate's answer:\n${answer}`,
        },
      ],
      { tier: "heavy", temperature: 0.4, maxTokens: 800 },
    );

    const rating = Math.min(5, Math.max(1, Math.round(Number(data.rating) || 3)));
    return {
      evaluation: {
        rating,
        text: typeof data.text === "string" ? data.text : "",
        strengths: Array.isArray(data.strengths) ? data.strengths : undefined,
        improvements: Array.isArray(data.improvements) ? data.improvements : undefined,
      },
      degraded: false,
    };
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      return { evaluation: heuristicEvaluation(answer), degraded: true };
    }
    throw err;
  }
}

/** Last-resort heuristic when no LLM is available. Honest, not pretending to be AI. */
function heuristicEvaluation(answer: string): Evaluation {
  const wordCount = answer.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 20) {
    return { rating: 2, text: "Heuristic (AI unavailable): answer is very brief — use the STAR method to add structure and detail." };
  }
  if (wordCount < 60) {
    return { rating: 3, text: "Heuristic (AI unavailable): reasonable length — add specific metrics and outcomes to strengthen it." };
  }
  return { rating: 4, text: "Heuristic (AI unavailable): substantial answer — ensure it stays focused and outcome-oriented." };
}

app.post("/session", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { jobId } = body;

  // Pull job context (if any) so generated questions are role-specific.
  let job: { company: string | null; role_title: string | null; jd_text: string | null } | null = null;
  if (jobId) {
    const jobResult = await query<{
      company: string | null;
      role_title: string | null;
      jd_text: string | null;
    }>("SELECT company, role_title, jd_text FROM jobs WHERE id = $1", [jobId]);
    job = jobResult.rows[0] ?? null;
  }

  const { questions, degraded } = await generateQuestions(job);

  // Persist session + questions atomically so a partial failure leaves no
  // orphan session with zero questions.
  const { session, rows } = await withTransaction(async (tx) => {
    const sessionResult = await tx.query(
      `INSERT INTO interview_sessions (user_id, job_id, interview_type, total_questions, created_at)
       VALUES ($1, $2, 'mock', $3, NOW())
       RETURNING id, user_id, job_id, interview_type, total_questions, created_at`,
      [userId, jobId || null, questions.length],
    );
    const sess = sessionResult.rows[0];

    for (let i = 0; i < questions.length; i++) {
      await tx.query(
        `INSERT INTO interview_questions (session_id, question_order, question_text, category, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [sess.id, i + 1, questions[i].text, questions[i].category],
      );
    }

    const q = await tx.query(
      "SELECT id, question_order, question_text, category FROM interview_questions WHERE session_id = $1 ORDER BY question_order",
      [sess.id],
    );
    return { session: sess, rows: q.rows };
  });

  return c.json({ session, questions: rows, aiGenerated: !degraded }, 201);
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
  if (sessionCheck.rows.length === 0) throw new NotFoundError("Session not found");

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

  if (typeof answer !== "string" || answer.trim().length === 0) {
    throw new ValidationError("answer is required");
  }

  const sessionCheck = await query(
    "SELECT id FROM interview_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (sessionCheck.rows.length === 0) throw new NotFoundError("Session not found");

  // Load the question being answered so the evaluator has full context.
  const qResult = await query(
    "SELECT question_text, category FROM interview_questions WHERE id = $1 AND session_id = $2",
    [questionId, sessionId],
  );
  if (qResult.rows.length === 0) throw new NotFoundError("Question not found");
  const { question_text, category } = qResult.rows[0];

  const { evaluation, degraded } = await evaluateAnswer(question_text, category, answer);

  // Store the full structured feedback in ai_feedback as JSON so the UI can
  // render strengths/improvements; keep ai_rating as the numeric column.
  const feedbackJson = JSON.stringify({
    text: evaluation.text,
    strengths: evaluation.strengths ?? [],
    improvements: evaluation.improvements ?? [],
    aiGenerated: !degraded,
  });

  const result = await query(
    `UPDATE interview_questions
     SET user_answer = $1, ai_feedback = $2, ai_rating = $3
     WHERE id = $4 AND session_id = $5
     RETURNING *`,
    [answer, feedbackJson, evaluation.rating, questionId, sessionId],
  );
  if (result.rows.length === 0) throw new NotFoundError("Question not found");

  return c.json({
    question: result.rows[0],
    feedback: { ...evaluation, aiGenerated: !degraded },
  });
});

export default app;
