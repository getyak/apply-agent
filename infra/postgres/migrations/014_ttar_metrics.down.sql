-- 014 down: rollback TTAR metrics column on application_drafts
--
-- Cleanly reverses 014_ttar_metrics.up.sql. Drops index first then the column;
-- index drop is implicit on column drop but kept explicit to mirror the up.

BEGIN;

DROP INDEX IF EXISTS idx_apps_ttar_success;

ALTER TABLE application_drafts
    DROP COLUMN IF EXISTS ttar_metrics;

COMMIT;
