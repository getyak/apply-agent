-- 024 up: reproducible Career Graph compiler profiles and quality evidence.
--
-- A tailored résumé version must record not just the selected graph revision
-- and JD, but also the deterministic length/locale/ATS policy used to render
-- it.  Quality is stored separately from the fabrication guard so callers can
-- review layout/ATS warnings without weakening the source-only invariant.

BEGIN;

ALTER TABLE career_graph_compilations
    ADD COLUMN compiler_config JSONB NOT NULL DEFAULT
        '{
          "profile_version": 0,
          "artifact_locale": "legacy_request_locale",
          "length_budget": "legacy_unbounded",
          "ats_profile": "not_assessed",
          "max_achievements_per_role": 4
        }'::jsonb,
    ADD COLUMN quality_report JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE career_graph_compilations
    ADD CONSTRAINT career_graph_compilations_compiler_config_object
        CHECK (jsonb_typeof(compiler_config) = 'object'),
    ADD CONSTRAINT career_graph_compilations_compiler_config_values
        CHECK (
            compiler_config ? 'profile_version'
            AND (
                (
                    compiler_config->>'profile_version' = '0'
                    AND compiler_config->>'artifact_locale' = 'legacy_request_locale'
                    AND compiler_config->>'length_budget' = 'legacy_unbounded'
                    AND compiler_config->>'ats_profile' = 'not_assessed'
                )
                OR (
                    compiler_config->>'profile_version' = '1'
                    AND compiler_config->>'artifact_locale' IN ('en', 'zh')
                    AND compiler_config->>'length_budget' IN ('one_page', 'two_page')
                    AND compiler_config->>'ats_profile' IN ('standard', 'strict')
                )
            )
        ),
    ADD CONSTRAINT career_graph_compilations_quality_report_object
        CHECK (jsonb_typeof(quality_report) = 'object');

COMMENT ON COLUMN career_graph_compilations.compiler_config IS
    'Versioned deterministic locale, length-budget, and ATS compiler inputs.';
COMMENT ON COLUMN career_graph_compilations.quality_report IS
    'Review evidence for ATS checks, estimated length, JD coverage, and omitted graph nodes.';

CREATE OR REPLACE FUNCTION prevent_career_graph_compilation_resume_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM career_graph_compilations
         WHERE resume_id = OLD.id
    ) THEN
        RAISE EXCEPTION
            'Career Graph compiled résumés are immutable; create a new compilation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_career_graph_compilation_resume_immutable
    BEFORE UPDATE OF content, version, is_base, tailored_for_job, track,
                     derived_from, parent_version
    ON resumes
    FOR EACH ROW
    EXECUTE FUNCTION prevent_career_graph_compilation_resume_mutation();

COMMIT;
