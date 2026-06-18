-- 009: Interviews domain — rollback
-- Reverse of 009_interviews.sql. Drops the interview_question_pool
-- (data-flywheel target — vantage-ui-mapping.md §3.5) plus the per-
-- session question rows and the session header.
--
-- 012_vantage_ui.sql adds a partial unique index on
-- conversation_sessions for ask_vantage threads; that lives in 007's
-- table space, not here, so we don't need to touch it.

DROP INDEX IF EXISTS idx_pool_embedding;
DROP INDEX IF EXISTS idx_pool_company_role;
DROP TABLE IF EXISTS interview_question_pool;

DROP INDEX IF EXISTS idx_interview_questions_session;
DROP TABLE IF EXISTS interview_questions;

DROP INDEX IF EXISTS idx_interview_sessions_user;
DROP TABLE IF EXISTS interview_sessions;
