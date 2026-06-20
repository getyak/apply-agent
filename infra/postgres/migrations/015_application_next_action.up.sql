-- 015 up: application state machine (P3.2)
--
-- Adds two columns to application_drafts so the kanban can render
-- "what is the user supposed to do next on this row" without inferring
-- it client-side every time. The reconcile job (Phase 3 follow-up,
-- not in this migration) will write these on a schedule. Until then
-- the columns stay NULL and the front-end falls back to its existing
-- column-derived hints.
--
-- next_action:
--   prep          — user still needs to finalise the submission package
--   submit        — package is ready, waiting on extension submission
--   follow_up     — 7d since submit, no recruiter contact yet
--   interview     — interview_date is in the next 7 days
--   close_loop    — outcome arrived, encourage the user to log learnings
--
-- next_action_due:
--   When that action becomes / became actionable. Used by the dock's
--   today queue to sort "due soonest" first.

ALTER TABLE application_drafts
    ADD COLUMN IF NOT EXISTS next_action TEXT
        CHECK (next_action IN (
            'prep',
            'submit',
            'follow_up',
            'interview',
            'close_loop'
        )),
    ADD COLUMN IF NOT EXISTS next_action_due TIMESTAMPTZ;

-- Index supports the today queue lookup (P3.1) once the reconcile job
-- ships — current queries are user-scoped + sort by due_at, which this
-- composite serves directly without forcing a full scan.
CREATE INDEX IF NOT EXISTS idx_apps_user_next_action_due
    ON application_drafts (user_id, next_action_due NULLS LAST);
