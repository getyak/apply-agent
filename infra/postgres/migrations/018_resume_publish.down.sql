-- 018 down: reverse résumé publish-link columns.
--
-- Drops the partial unique index first, then the two columns. The published_at
-- timestamps are lost on rollback — acceptable because publish links are an
-- additive feature; nothing else in the schema references them.

BEGIN;

DROP INDEX IF EXISTS idx_resumes_publish_token;

ALTER TABLE resumes DROP COLUMN IF EXISTS publish_token;
ALTER TABLE resumes DROP COLUMN IF EXISTS published_at;

COMMIT;
