-- 001: Extensions — rollback
-- Reverse of 001_extensions.sql. By the time we reach this script in a
-- full rollback chain every table that uses pgvector / pg_trgm has
-- already been dropped (009 → 008 → … → 002). DROP EXTENSION still uses
-- CASCADE as a belt-and-braces guard against a partial rollback that
-- left dependent objects behind.
--
-- DROP EXTENSION IF NOT EXISTS is a no-op when the extension is absent,
-- so this script is idempotent against a CI fresh-DB target.

DROP EXTENSION IF EXISTS "pg_trgm" CASCADE;
DROP EXTENSION IF EXISTS "vector"  CASCADE;
DROP EXTENSION IF EXISTS "pgcrypto" CASCADE;
DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;
