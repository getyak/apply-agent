-- 017 down: remove dual-track résumé model.
--
-- Reverses 017_resume_dual_track.up.sql. Drops the suggestion table, the
-- immutability trigger, and the columns added to resumes. Existing rows keep
-- their content; the track/derived_from/bullet_index data is lost (acceptable
-- on a rollback — the old code paths key off is_base / tailored_for_job).

BEGIN;

DROP TRIGGER IF EXISTS trg_resumes_original_immutable ON resumes;
DROP FUNCTION IF EXISTS prevent_original_mutation();

DROP TABLE IF EXISTS resume_suggestions;

DROP INDEX IF EXISTS idx_resumes_user_track;
DROP INDEX IF EXISTS idx_resumes_derived_from;

ALTER TABLE resumes DROP CONSTRAINT IF EXISTS resumes_track_check;

ALTER TABLE resumes DROP COLUMN IF EXISTS bullet_index;
ALTER TABLE resumes DROP COLUMN IF EXISTS derived_from;
ALTER TABLE resumes DROP COLUMN IF EXISTS track;

COMMIT;
