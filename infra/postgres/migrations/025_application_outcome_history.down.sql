-- 025 down: remove append-only lifecycle history and restore the v1 status set.

BEGIN;

DROP TRIGGER IF EXISTS trg_application_outcome_event_capture ON application_drafts;
DROP FUNCTION IF EXISTS capture_application_outcome_event();
DROP TRIGGER IF EXISTS trg_application_outcome_events_immutable ON application_outcome_events;
DROP FUNCTION IF EXISTS prevent_application_outcome_event_mutation();
DROP TABLE IF EXISTS application_outcome_events;
DROP INDEX IF EXISTS idx_application_drafts_owner_resume;
ALTER TABLE application_drafts
    DROP CONSTRAINT IF EXISTS application_drafts_id_user_unique;

-- Preserve the meaning of statuses introduced by this migration in the
-- free-text outcome before mapping them back to the original state machine.
UPDATE application_drafts
SET
    outcome = CASE
        WHEN COALESCE(outcome, '') = '' AND status IN ('ghosted', 'accepted', 'closed')
        THEN status
        ELSE outcome
    END,
    status = CASE
        WHEN status = 'accepted' THEN 'offer'
        WHEN status IN ('ghosted', 'closed') THEN 'rejected'
        ELSE status
    END
WHERE status IN ('ghosted', 'accepted', 'closed');

ALTER TABLE application_drafts
    DROP CONSTRAINT IF EXISTS application_drafts_status_check,
    ADD CONSTRAINT application_drafts_status_check CHECK (status IN (
        'draft',
        'review',
        'submitted',
        'interview',
        'rejected',
        'offer',
        'withdrawn'
    ));

COMMIT;
