-- 030 up: make literal skill-demand fallback queries interactive.
--
-- Most externally ingested jobs predate structured `parsed.skills`. The
-- trends endpoint therefore checks a small, explicit vocabulary against raw
-- JD text. A trigram GIN index keeps those evidence-backed regex checks from
-- scanning every large JD once per vocabulary item.

CREATE INDEX IF NOT EXISTS idx_jobs_active_jd_text_trgm
    ON jobs USING GIN (jd_text gin_trgm_ops)
    WHERE is_active = true AND jd_text IS NOT NULL;
