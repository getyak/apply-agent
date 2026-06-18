-- 004: Resume domain — rollback
-- Reverse of 004_resumes.sql. Drops the FK that 004 added back onto 003's
-- user_files table first (so dropping resumes doesn't cascade-corrupt
-- file rows), then the resumes indexes and table.

ALTER TABLE user_files DROP CONSTRAINT IF EXISTS fk_files_resume;

DROP INDEX IF EXISTS idx_resumes_embedding;
DROP INDEX IF EXISTS idx_resumes_base;
DROP INDEX IF EXISTS idx_resumes_user;
DROP TABLE IF EXISTS resumes;
