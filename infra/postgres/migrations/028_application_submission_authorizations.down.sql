BEGIN;

DROP TRIGGER IF EXISTS trg_application_drafts_consume_submission_authorization
    ON application_drafts;
DROP FUNCTION IF EXISTS consume_codex_application_submission_authorization();

DROP TRIGGER IF EXISTS trg_application_submission_authorizations_guard
    ON application_submission_authorizations;
DROP FUNCTION IF EXISTS guard_application_submission_authorization_mutation();

DROP TABLE IF EXISTS application_submission_authorizations;

COMMIT;
