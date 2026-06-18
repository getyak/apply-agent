-- 006: Applications domain — rollback
-- Reverse of 006_applications.sql. Single table with its trigger; the
-- shared update_updated_at() function is owned by 002 and is left alone
-- here (other tables still need it).

DROP INDEX IF EXISTS idx_apps_job;
DROP INDEX IF EXISTS idx_apps_user;
DROP TABLE IF EXISTS application_drafts;
