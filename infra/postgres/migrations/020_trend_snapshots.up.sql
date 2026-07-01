-- 020 up: TrendAgent persistence — daily market snapshots + per-skill time series
--
-- Backs docs/product-spec.md § 6 (Daily trend analysis) and the north-star
-- "if you learn X, +Y roles" hook in docs/vision.md. The spec earmarks DuckDB
-- for the analytical layer, but the MVP lands it in the existing PG (5433) so
-- the dock's ``trends_today`` tool can read it with the same pg_query helper as
-- every other agent — no second engine to stand up for a first cut.
--
-- trend_snapshots: one row per ETL date. ``skills`` / ``top_roles`` / ``insights``
-- are JSONB so the shape can evolve without a migration. Canonical shapes:
--   skills:    [{"skill": "TypeScript", "count": 42, "trend_pct_7d": 8.3}, ...]  (desc by count)
--   top_roles: [{"role": "Backend Engineer", "count": 31}, ...]
--   insights:  [{"skill": "Rust", "count": 12, "unlock_roles": 47,
--                "message": "if you learn Rust, +47 roles"}, ...]
--
-- skill_trends: normalised per-(skill, date) time series so the 7-day trend %
-- on a snapshot can be recomputed / audited, and future SkillTrend queries
-- (docs/data-model.md § Analytics tables) have a home.

BEGIN;

CREATE TABLE IF NOT EXISTS trend_snapshots (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    snapshot_date  DATE NOT NULL,
    total_jobs     INT  NOT NULL DEFAULT 0,
    new_jobs_today INT  NOT NULL DEFAULT 0,
    sources        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["stripe","airbnb",...]
    skills         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- top skills by count (desc)
    top_roles      JSONB NOT NULL DEFAULT '[]'::jsonb,
    salary_stats   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {min,max,median,currency}
    remote_ratio   NUMERIC(4, 3),                       -- 0.000–1.000
    insights       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- "learn X → +Y roles" cards
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One canonical snapshot per date; re-running the ETL UPSERTs.
    CONSTRAINT uq_trend_snapshots_date UNIQUE (snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_trend_snapshots_date
    ON trend_snapshots (snapshot_date DESC);

CREATE TABLE IF NOT EXISTS skill_trends (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    skill         TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    count         INT  NOT NULL DEFAULT 0,
    avg_salary    NUMERIC(12, 2),
    trend_pct_7d  NUMERIC(6, 2),
    trend_pct_30d NUMERIC(6, 2),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One row per skill per day; re-running the ETL UPSERTs.
    CONSTRAINT uq_skill_trends_skill_date UNIQUE (skill, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_skill_trends_skill_date
    ON skill_trends (skill, snapshot_date DESC);

COMMIT;
