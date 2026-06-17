-- 011 up: Move auth credential column into a real migration.
--
-- Previously the API added this column at boot via a runtime
-- `ALTER TABLE users ADD COLUMN password_hash` (schema drift outside the
-- migration history). It now lives here so a fresh `make db-reset && make up`
-- produces the complete schema and CI can validate it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
