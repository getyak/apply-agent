-- 003: Files domain — rollback
-- Reverse of 003_files.sql. user_file_versions FK-references user_files,
-- so drop the versions table first.

DROP TABLE IF EXISTS user_file_versions;

DROP INDEX IF EXISTS idx_user_files_type;
DROP INDEX IF EXISTS idx_user_files_user;
DROP TABLE IF EXISTS user_files;
