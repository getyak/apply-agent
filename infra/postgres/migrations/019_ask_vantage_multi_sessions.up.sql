-- 019 up: allow multiple ask_vantage sessions per user (multi-session dock).
--
-- Background: 012 introduced a unique index ``idx_sessions_ask_vantage_per_user``
-- to enforce one lifetime ask_vantage thread per user. The product now ships
-- a "+ New session" affordance in the dock header (and on /app/chat), so a
-- user can hold parallel threads (e.g. "Stripe deep dive" vs the lifetime
-- catch-all). The thread_id used by LangGraph PostgresSaver is no longer
-- derivable from user_id alone — secondary sessions carry their own
-- ``ask_vantage:{user_id}:{session_id}`` thread.
--
-- Changes:
--   1. drop UNIQUE constraint, replace with a partial INDEX (still scoped to
--      ask_vantage rows) so by-user lookups stay fast
--   2. add ``last_preview TEXT`` — last user prompt snippet for the session
--      list UI (truncated to ~160 chars at write time by the app)
--   3. add ``thread_id TEXT`` — the canonical LangGraph thread name used by
--      this session. NULL means "use the legacy derived thread"; new rows
--      must populate it.
--   4. add a partial index for active sessions ordered by last_active_at
--      (powers the dock SessionSwitcher list)
--
-- See docs/architecture/vantage-ui-mapping.md §1.2.

BEGIN;

-- 1. Drop the UNIQUE constraint on ask_vantage sessions.
DROP INDEX IF EXISTS idx_sessions_ask_vantage_per_user;

-- 2. last_preview — kept short by the app; we don't enforce a CHECK because
-- LLM-generated previews can swell during edits and we'd rather truncate
-- than reject.
ALTER TABLE conversation_sessions
    ADD COLUMN IF NOT EXISTS last_preview TEXT;

-- 3. thread_id — explicit LangGraph thread name. Old rows are backfilled to
-- the legacy derived shape ``ask_vantage:{user_id}`` so existing dock
-- history keeps loading without a code change.
ALTER TABLE conversation_sessions
    ADD COLUMN IF NOT EXISTS thread_id TEXT;

UPDATE conversation_sessions
   SET thread_id = 'ask_vantage:' || user_id::text
 WHERE session_type = 'ask_vantage'
   AND thread_id IS NULL;

-- Uniqueness on thread_id within ask_vantage rows — same user can hold
-- multiple sessions but each must map to a distinct LangGraph thread.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_ask_vantage_thread_id
    ON conversation_sessions(thread_id)
    WHERE session_type = 'ask_vantage' AND thread_id IS NOT NULL;

-- 4. Per-user activity index for the SessionSwitcher list.
CREATE INDEX IF NOT EXISTS idx_sessions_ask_vantage_by_user_active
    ON conversation_sessions(user_id, last_active_at DESC)
    WHERE session_type = 'ask_vantage';

COMMIT;
