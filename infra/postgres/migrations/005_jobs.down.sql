-- 005: Job domain — rollback
-- Reverse of 005_jobs.sql. The forward migration not only creates the
-- `jobs` table but also adds two FK constraints onto earlier tables
-- (resumes.tailored_for_job, user_files.linked_job_id). We MUST drop
-- those constraints first — otherwise DROP TABLE jobs would either
-- fail or implicitly cascade and silently corrupt the FK landscape on
-- a partial rollback.

ALTER TABLE user_files DROP CONSTRAINT IF EXISTS fk_files_job;
ALTER TABLE resumes    DROP CONSTRAINT IF EXISTS fk_resumes_job;

DROP INDEX IF EXISTS idx_jobs_embedding;
DROP INDEX IF EXISTS idx_jobs_company;
DROP INDEX IF EXISTS idx_jobs_active;
DROP TABLE IF EXISTS jobs;
