-- 018 up: résumé read-only publish links.
--
-- Backs the "Share" lane of the résumé operations center
-- (delivery page /app/resume/[id] + public read-only /r/[token]).
--
-- The model intentionally lives ON the resumes row (not in a side table):
--   · one row = one résumé version, and either it's published or it's not,
--   · "revoke" is a NULL update — fast, atomic, and keeps an audit trail of
--     who once published what (published_at stays set until the next publish).
--
-- Token model: 16 random bytes hex-encoded (32 chars), generated SERVER-SIDE
-- with crypto.randomBytes — 2^128 keyspace, unguessable, no enumeration risk.
-- The partial UNIQUE index protects against accidental collisions and lets
-- NULL coexist freely (revoked rows don't fight for index slots).
--
-- Idempotent: re-running is safe (IF NOT EXISTS guards).

BEGIN;

ALTER TABLE resumes
    ADD COLUMN IF NOT EXISTS published_at  TIMESTAMPTZ;

ALTER TABLE resumes
    ADD COLUMN IF NOT EXISTS publish_token TEXT;

-- Partial unique index: only enforces uniqueness on rows that are actually
-- published. Revoked rows (publish_token IS NULL) coexist freely, and the
-- lookup at GET /api/public/r/:token is a single index probe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_resumes_publish_token
    ON resumes (publish_token)
    WHERE publish_token IS NOT NULL;

COMMIT;
