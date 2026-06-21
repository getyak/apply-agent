// GET /api/today/queue — Action queue (audit P3.1)
//
// Returns the top ~5 "do these things today" actions, mixed from three
// sources and ranked by a single priority score so the dock surface
// looks like "today, 3 things move you forward" instead of "here are
// snapshots, you decide what to do with them".
//
// Sources (best-effort; any individual query failure is logged and
// dropped, never failing the whole endpoint — the front-end always
// gets *some* queue):
//
//  - applications waiting on the user to act (drafts / review state)
//  - applications with an upcoming interview_date
//  - one personalised "learn this skill" insight pulled from
//    /api/trends/personalized's underlying logic (kept inline so this
//    route doesn't take a hard dep on trends.ts)
//
// Each action carries an `ask_prompt` field — the dock's CTA can drop
// it straight into ask-vantage to start the relevant agent workflow
// without the user having to type.

import { Hono } from "hono";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

type ActionKind = "prepare" | "follow_up" | "interview" | "learn";

interface TodayAction {
  id: string;
  kind: ActionKind;
  title: string;
  // One-line context (e.g. "Stripe staff eng — due in 2 days")
  sub: string;
  // ISO date when this action becomes / became due. Optional for
  // "learn" actions which don't have a hard deadline.
  due_at?: string;
  // 0–100, higher = surface earlier. Computed below.
  priority: number;
  // Tap target: same-origin route to jump into.
  route: string;
  // Optional pre-baked prompt for "Talk it through with Vantage" CTA.
  ask_prompt?: string;
}

app.get("/queue", async (c) => {
  const userId = c.get("userId");

  const actions: TodayAction[] = [];

  // ── 1. Application drafts waiting on user action ─────────────────
  // status in (draft, review) means the user still has prep work to
  // do before submission. We surface the 3 oldest so the queue stays
  // first-in-first-out — newest first would punish the user for
  // letting things age.
  try {
    const rows = await query(
      `SELECT a.id, a.status, a.updated_at,
              j.company, j.role_title
         FROM application_drafts a
         JOIN jobs j ON j.id = a.job_id
        WHERE a.user_id = $1
          AND a.status IN ('draft', 'review')
        ORDER BY a.updated_at ASC
        LIMIT 3`,
      [userId],
    );
    for (const r of rows.rows) {
      const age_days = Math.floor(
        (Date.now() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      actions.push({
        id: `app-${r.id}`,
        kind: "prepare",
        title: `Prep your ${r.company} application`,
        sub:
          age_days <= 0
            ? `${r.role_title} — still in draft`
            : `${r.role_title} — sitting for ${age_days}d`,
        // No hard due_at; we score by age instead.
        priority: 70 + Math.min(20, age_days * 2),
        route: `/app/applications#app-${r.id}`,
        ask_prompt: `Help me finish the ${r.company} application prep package.`,
      });
    }
  } catch (err) {
    console.warn("[today] application drafts query failed:", err);
  }

  // ── 2. Upcoming interviews ───────────────────────────────────────
  // Anything with interview_date in the next 7 days gets surfaced;
  // anything further out can wait. We score by inverse distance so
  // "tomorrow" beats "Friday" beats "next Tuesday" naturally.
  try {
    const rows = await query(
      `SELECT a.id, a.interview_date,
              j.company, j.role_title
         FROM application_drafts a
         JOIN jobs j ON j.id = a.job_id
        WHERE a.user_id = $1
          AND a.interview_date IS NOT NULL
          AND a.interview_date BETWEEN CURRENT_DATE
                                   AND CURRENT_DATE + INTERVAL '7 days'
        ORDER BY a.interview_date ASC
        LIMIT 2`,
      [userId],
    );
    for (const r of rows.rows) {
      const days =
        Math.floor(
          (new Date(r.interview_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        ) + 1;
      actions.push({
        id: `int-${r.id}`,
        kind: "interview",
        title: `Practise the ${r.company} interview`,
        sub:
          days <= 0
            ? `${r.role_title} — today`
            : days === 1
              ? `${r.role_title} — tomorrow`
              : `${r.role_title} — in ${days} days`,
        due_at: new Date(r.interview_date).toISOString(),
        // Floor at 80 so an interview-in-7-days still beats a
        // medium-age draft application; ceiling at 100 for today.
        priority: Math.max(80, 100 - days * 3),
        route: `/app/studio/mock`,
        ask_prompt: `Run a mock interview for ${r.company} ${r.role_title}.`,
      });
    }
  } catch (err) {
    console.warn("[today] interviews query failed:", err);
  }

  // ── 3. One "learn this" market signal ────────────────────────────
  // We don't want to flood the queue with three different skill
  // suggestions — that turns "today's 3 things" into a learning
  // backlog. One missing-skill nudge per user per render keeps the
  // queue feeling actionable instead of guilt-inducing.
  try {
    const resumeRows = await query(
      `SELECT content
         FROM resumes
        WHERE user_id = $1 AND is_base = true
        ORDER BY version DESC
        LIMIT 1`,
      [userId],
    );
    if (resumeRows.rows.length > 0) {
      const raw = resumeRows.rows[0].content;
      const content = typeof raw === "string" ? JSON.parse(raw) : raw;
      const userSkills = new Set<string>();
      if (content?.skills) {
        for (const s of content.skills) {
          const name = typeof s === "string" ? s : s.name;
          if (typeof name === "string") userSkills.add(name.toLowerCase());
        }
      }

      const trendingRows = await query(`
        SELECT skill, COUNT(*) AS demand
          FROM jobs, jsonb_array_elements_text(parsed->'skills') AS skill
         WHERE is_active = true AND posted_date > NOW() - INTERVAL '30 days'
         GROUP BY skill
         ORDER BY demand DESC
         LIMIT 20
      `);
      const missing = trendingRows.rows.find(
        (r) => !userSkills.has((r.skill as string).toLowerCase()),
      );
      if (missing) {
        actions.push({
          id: `learn-${(missing.skill as string).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          kind: "learn",
          title: `Learn ${missing.skill}`,
          sub: `Trending — ${missing.demand} open roles ask for it`,
          // Always below interview/prep urgency — learning is rarely
          // today-critical.
          priority: 40,
          route: `/app/today`,
          ask_prompt: `Why is ${missing.skill} trending and where can I start?`,
        });
      }
    }
  } catch (err) {
    console.warn("[today] learn signal query failed:", err);
  }

  actions.sort((a, b) => b.priority - a.priority);

  return c.json({
    actions: actions.slice(0, 5),
    generated_at: new Date().toISOString(),
  });
});

export default app;
