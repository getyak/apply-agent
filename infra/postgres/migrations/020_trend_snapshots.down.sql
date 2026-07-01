-- 020 down: rollback TrendAgent persistence tables
--
-- Cleanly reverses 020_trend_snapshots.up.sql. Indexes drop implicitly with
-- their tables but are listed explicitly to mirror the up migration.

BEGIN;

DROP INDEX IF EXISTS idx_skill_trends_skill_date;
DROP TABLE IF EXISTS skill_trends;

DROP INDEX IF EXISTS idx_trend_snapshots_date;
DROP TABLE IF EXISTS trend_snapshots;

COMMIT;
