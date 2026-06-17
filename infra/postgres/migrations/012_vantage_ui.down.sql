-- 012 down: rollback Vantage UI schema additions
--
-- Cleanly reverses 012_vantage_ui.up.sql. Order matters: drop FK-dependent
-- columns/indexes before the referenced table.

BEGIN;

-- ── 4. interview_questions: drop three-perspective columns ─────────────
DROP INDEX IF EXISTS idx_iq_real_for_pool;
DROP INDEX IF EXISTS idx_iq_follow_up;

ALTER TABLE interview_questions
    DROP COLUMN IF EXISTS is_real,
    DROP COLUMN IF EXISTS follow_up_of,
    DROP COLUMN IF EXISTS feedback_translation;

-- ── 3. interview_sessions: drop mode link + intel + weak_points ────────
DROP INDEX IF EXISTS idx_interview_sessions_mode;

ALTER TABLE interview_sessions
    DROP COLUMN IF EXISTS weak_points,
    DROP COLUMN IF EXISTS intel_brief,
    DROP COLUMN IF EXISTS mode_id;

-- ── 2. interview_modes: drop entire table ──────────────────────────────
DROP TABLE IF EXISTS interview_modes;

-- ── 1. conversation_sessions: revert session_type enum ─────────────────
-- Must remove any rows using the new values first, or the constraint re-add fails.
DELETE FROM conversation_sessions
    WHERE session_type IN ('ask_vantage', 'build_from_scratch', 'mock_live');

ALTER TABLE conversation_sessions
    DROP CONSTRAINT conversation_sessions_session_type_check;

ALTER TABLE conversation_sessions
    ADD CONSTRAINT conversation_sessions_session_type_check
    CHECK (session_type IN (
        'resume_optimization', 'interview_prep', 'job_search',
        'application_prep', 'general'
    ));

DROP INDEX IF EXISTS idx_sessions_ask_vantage_per_user;

COMMIT;
