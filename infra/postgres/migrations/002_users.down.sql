-- 002: Users domain — rollback
-- Reverse of 002_users.sql. user_devices FK-references users so drop it
-- first. The shared update_updated_at() trigger function is also owned
-- by 002 — any later migration that uses it (005/006/008) will have
-- been rolled back by its own .down.sql before we reach here, so it's
-- safe to drop. Postgres DROP FUNCTION ... IF EXISTS is a no-op if
-- nothing's there, so re-running this script is idempotent.

DROP INDEX IF EXISTS idx_user_devices_user;
DROP TABLE IF EXISTS user_devices;

DROP TABLE IF EXISTS users;

DROP FUNCTION IF EXISTS update_updated_at();
