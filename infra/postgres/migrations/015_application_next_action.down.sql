-- 015 down: revert application state machine columns (P3.2)
--
-- Drop the index first so the column drop doesn't cascade-rebuild it
-- in the rollback path.

DROP INDEX IF EXISTS idx_apps_user_next_action_due;

ALTER TABLE application_drafts
    DROP COLUMN IF EXISTS next_action_due,
    DROP COLUMN IF EXISTS next_action;
