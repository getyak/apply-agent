-- 012 up: schema support for Vantage UI (Ask Vantage dock · Résumé view · Mock pluggable modes)
--
-- Backs three UI modules introduced in docs/architecture/vantage-ui-mapping.md:
--   1. Ask Vantage persistent dock — long-lived thread per user
--   2. Résumé as document + version timeline (no separate chat)
--   3. Mock interview as pluggable modes (intel × pressure × feedback × loop)

BEGIN;

-- ── 1. conversation_sessions: extend session_type enum ─────────────────
-- Add: ask_vantage (dock 终身对话), build_from_scratch (从零搭简历 workflow),
--      mock_live (沉浸 Mock session).
ALTER TABLE conversation_sessions
    DROP CONSTRAINT conversation_sessions_session_type_check;

ALTER TABLE conversation_sessions
    ADD CONSTRAINT conversation_sessions_session_type_check
    CHECK (session_type IN (
        'resume_optimization', 'interview_prep', 'job_search',
        'application_prep', 'general',
        'ask_vantage', 'build_from_scratch', 'mock_live'
    ));

-- One persistent ask_vantage thread per user (terminal-lifetime).
-- thread_id maps to LangGraph PostgresSaver via deterministic UUID v5 from user_id.
CREATE UNIQUE INDEX idx_sessions_ask_vantage_per_user
    ON conversation_sessions(user_id)
    WHERE session_type = 'ask_vantage';

-- ── 2. interview_modes: pluggable mode registry ────────────────────────
-- Built-in modes (scene_recreation / pressure_drill / warm_up / rapid_fire)
-- seeded by the application; users can create their own via the UI.
CREATE TABLE interview_modes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    -- NULL user_id == built-in (system-owned)
    slug            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    description     TEXT,

    -- four pluggable dimensions (chat2.md § 深度分析 锚点)
    intel_strategy  TEXT NOT NULL CHECK (intel_strategy IN (
        'none', 'jd_based', 'crowdsourced', 'recruiter_specific'
    )),
    pressure_level  TEXT NOT NULL CHECK (pressure_level IN (
        'encourage_only', 'one_follow_up', 'chained_to_stuck'
    )),
    feedback_style  TEXT NOT NULL CHECK (feedback_style IN (
        'rating_1to5', 'three_perspective_translation', 'one_line_per_answer'
    )),
    loop_behavior   TEXT NOT NULL CHECK (loop_behavior IN (
        'standalone', 'save_to_card', 'replay_real_interview'
    )),

    is_built_in     BOOLEAN NOT NULL DEFAULT false,
    is_archived     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A user can have one mode per slug; built-ins are globally unique by slug.
    UNIQUE(user_id, slug)
);

-- Built-in modes (user_id IS NULL) must have globally unique slugs too.
CREATE UNIQUE INDEX idx_modes_builtin_slug
    ON interview_modes(slug)
    WHERE user_id IS NULL;

CREATE INDEX idx_modes_user ON interview_modes(user_id)
    WHERE is_archived = false;

-- ── 3. interview_sessions: link to mode + carry intel + weak_points ────
ALTER TABLE interview_sessions
    ADD COLUMN mode_id        UUID REFERENCES interview_modes(id) ON DELETE SET NULL,
    ADD COLUMN intel_brief    JSONB,
    -- shape: { round_minutes, interviewer_style, frequent_questions: [{q, probability, trap}], jd_real_focus }
    ADD COLUMN weak_points    JSONB NOT NULL DEFAULT '[]'::jsonb;
    -- shape: [{ skill: "Owning impact", confidence: 0.3, last_session_id }]

CREATE INDEX idx_interview_sessions_mode ON interview_sessions(mode_id);

-- ── 4. interview_questions: three-perspective translation ──────────────
-- Replaces rating_1to5 as the primary feedback shape (rating kept for real_prep).
ALTER TABLE interview_questions
    ADD COLUMN feedback_translation JSONB,
    -- shape: {
    --   you_said: "...",
    --   interviewer_heard: "...",
    --   suggested_rephrase: "...",
    --   stuck_replay: "..." | null   -- only for pressure_drill mode
    -- }
    ADD COLUMN follow_up_of UUID REFERENCES interview_questions(id) ON DELETE SET NULL,
    ADD COLUMN is_real BOOLEAN NOT NULL DEFAULT false;
    -- is_real = true when user used "Log the real interview" — feeds the data flywheel.

CREATE INDEX idx_iq_follow_up ON interview_questions(follow_up_of);
CREATE INDEX idx_iq_real_for_pool ON interview_questions(session_id)
    WHERE is_real = true;

COMMIT;
