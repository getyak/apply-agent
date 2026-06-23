-- 017 up: dual-track résumé model + bullet-level stable IDs + suggestion stack
--
-- Backs docs/design/resume-original-vs-optimized-vibe-design.md §4 (data model).
--
-- The old model treated a résumé as a single linear version chain (v1 → v2 →
-- v3 …) plus per-JD tailored branches. That can't hold three things at once:
--   1. the uploaded original must stay visible & untouched (a trust contract),
--   2. "AI optimized" must be a resident sibling that does NOT require a JD,
--   3. a user must be able to refine one bullet at a time via vibe chat.
--
-- This migration introduces:
--   · resumes.track   — original | optimized | tailored axis
--   · resumes.derived_from — clearer replacement for parent_version semantics
--   · resumes.bullet_index — stable IDs per highlight (the physical basis of vibe)
--   · resume_suggestions — long-lived AI suggestion stack (proposed/accepted/…)
--   · prevent_original_mutation trigger — originals are immutable (§7.2)
--
-- Backfill is derived from the existing is_base / tailored_for_job columns;
-- no data is lost. Idempotent: re-running is safe (IF NOT EXISTS / guarded
-- backfill / CREATE OR REPLACE).

BEGIN;

-- ── 1. resumes: track + derived_from + bullet_index ────────────────────
ALTER TABLE resumes
    ADD COLUMN IF NOT EXISTS track TEXT;

ALTER TABLE resumes
    ADD COLUMN IF NOT EXISTS derived_from UUID REFERENCES resumes(id) ON DELETE SET NULL;

ALTER TABLE resumes
    ADD COLUMN IF NOT EXISTS bullet_index JSONB;
    -- shape: { "<stable_id>": {"path": "work.0.highlights.1",
    --                          "text_hash": "...", "anchor_text": "..."} }

-- ── 2. backfill track from existing columns ─────────────────────────────
-- original: the uploaded master (is_base = true)
-- tailored: anything bound to a specific job
-- optimized: everything else (manual branches, prior AI rewrites)
-- Guarded by `track IS NULL` so re-running never reclassifies fixed rows.
UPDATE resumes SET track = 'original'
    WHERE track IS NULL AND is_base = true;

UPDATE resumes SET track = 'tailored'
    WHERE track IS NULL AND tailored_for_job IS NOT NULL;

UPDATE resumes SET track = 'optimized'
    WHERE track IS NULL;

-- carry the old parent_version pointer into derived_from where it was set
UPDATE resumes SET derived_from = parent_version
    WHERE derived_from IS NULL AND parent_version IS NOT NULL;

-- now enforce NOT NULL + CHECK (every row classified above)
ALTER TABLE resumes
    ALTER COLUMN track SET DEFAULT 'optimized';

ALTER TABLE resumes
    ALTER COLUMN track SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'resumes_track_check'
    ) THEN
        ALTER TABLE resumes
            ADD CONSTRAINT resumes_track_check
            CHECK (track IN ('original', 'optimized', 'tailored'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_resumes_user_track ON resumes(user_id, track);
CREATE INDEX IF NOT EXISTS idx_resumes_derived_from ON resumes(derived_from);

-- ── 3. resume_suggestions: the AI suggestion stack ──────────────────────
-- Long-lived entities (a user may accept a suggestion two weeks later), with
-- a supersede chain (re-proposals) and dual rendering surfaces (dock + Studio).
-- This is why it's a table, not a JSONB blob inside resumes.content.
CREATE TABLE IF NOT EXISTS resume_suggestions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_resume_id  UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    bullet_stable_id  TEXT,                      -- set for bullet-level suggestions
    section           TEXT,                      -- summary | work | skills | …
    change_type       TEXT NOT NULL,             -- tighten | quantify_existing | reorder | infer_wording
    before_text       TEXT NOT NULL,
    after_text        TEXT NOT NULL,
    rationale         TEXT,
    risk_level        TEXT NOT NULL DEFAULT 'needs_review'
        CHECK (risk_level IN ('safe', 'needs_review', 'unsupported')),
    fabrication_check JSONB,                      -- guard output (entities checked, pass/fail)
    status            TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
    proposed_by       TEXT NOT NULL,             -- optimize_general | customize | vibe_chat
    superseded_by     UUID REFERENCES resume_suggestions(id) ON DELETE SET NULL,
    proposed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at        TIMESTAMPTZ,
    decided_via       TEXT                        -- dock_inline | studio_panel | auto
);

CREATE INDEX IF NOT EXISTS idx_resume_suggestions_user_status
    ON resume_suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_resume_suggestions_source
    ON resume_suggestions(source_resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_suggestions_bullet
    ON resume_suggestions(source_resume_id, bullet_stable_id)
    WHERE bullet_stable_id IS NOT NULL;

-- ── 4. originals are immutable (§7.2) ───────────────────────────────────
-- "Upload new" always inserts a NEW track='original' row; the old one is never
-- mutated. This trigger is the database-level guarantee behind that contract.
-- It only blocks content changes — metadata (label, embedding) may still move.
CREATE OR REPLACE FUNCTION prevent_original_mutation() RETURNS trigger AS $$
BEGIN
    IF OLD.track = 'original'
       AND NEW.content IS DISTINCT FROM OLD.content THEN
        RAISE EXCEPTION
            'Original résumés are immutable. Upload a new file instead.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_resumes_original_immutable ON resumes;
CREATE TRIGGER trg_resumes_original_immutable
    BEFORE UPDATE ON resumes
    FOR EACH ROW EXECUTE FUNCTION prevent_original_mutation();

COMMIT;
