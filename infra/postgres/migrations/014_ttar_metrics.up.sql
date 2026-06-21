-- 014 up: TTAR (Time-To-Application-Ready) metrics on application_drafts
--
-- Backs the north-star metric defined in
-- docs/architecture/delivery-loop-plan.md § 1.
--
-- ttar_metrics captures per-stage latency, success flag, fabrication retries,
-- and submit-side timings so the delivery loop is observable end-to-end.
-- Shape (JSONB), all fields optional so partial writes during workflow
-- progress remain valid:
--   {
--     "started_at":  "2026-06-19T07:12:01Z",
--     "completed_at":"2026-06-19T07:12:38Z",
--     "latency_ms":  37123,
--     "success":     true,
--     "stages": {
--        "parse_jd_ms":     2401,
--        "customize_ms":   18230,
--        "cover_ms":        7250,
--        "form_ms":         9120,
--        "extension_ms":    null
--     },
--     "fabrication_attempts": 0,
--     "fields_total":        12,
--     "fields_auto_filled":   8,
--     "fields_ai_filled":     3,
--     "fields_user_edited":   1
--   }

BEGIN;

ALTER TABLE application_drafts
    ADD COLUMN IF NOT EXISTS ttar_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Partial index over the success flag for the eval gate query
--   ("among prepares that actually completed, what's our latency p95?").
CREATE INDEX IF NOT EXISTS idx_apps_ttar_success
    ON application_drafts ((ttar_metrics->>'success'))
    WHERE ttar_metrics ? 'success';

COMMIT;
