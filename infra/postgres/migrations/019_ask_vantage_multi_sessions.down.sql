-- 019 down: revert multi ask_vantage sessions schema.
--
-- WARNING: if any user has more than one ask_vantage row this will fail when
-- re-applying the UNIQUE index. Operationally, before rolling back, run:
--   DELETE FROM conversation_sessions cs
--    USING (SELECT user_id, MIN(created_at) AS keep
--             FROM conversation_sessions
--            WHERE session_type = 'ask_vantage'
--            GROUP BY user_id HAVING COUNT(*) > 1) d
--    WHERE cs.user_id = d.user_id
--      AND cs.session_type = 'ask_vantage'
--      AND cs.created_at <> d.keep;
-- This is destructive — secondary sessions are dropped to satisfy the
-- UNIQUE invariant. Migration 019 itself is non-destructive in the up
-- direction; this down script intentionally exposes the data hazard.

BEGIN;

DROP INDEX IF EXISTS idx_sessions_ask_vantage_by_user_active;
DROP INDEX IF EXISTS idx_sessions_ask_vantage_thread_id;

ALTER TABLE conversation_sessions
    DROP COLUMN IF EXISTS thread_id;

ALTER TABLE conversation_sessions
    DROP COLUMN IF EXISTS last_preview;

-- Recreate the original UNIQUE invariant from 012.
CREATE UNIQUE INDEX idx_sessions_ask_vantage_per_user
    ON conversation_sessions(user_id)
    WHERE session_type = 'ask_vantage';

COMMIT;
