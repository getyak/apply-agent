-- 024 down: remove compiler profile and quality evidence columns.

BEGIN;

DROP TRIGGER IF EXISTS trg_career_graph_compilation_resume_immutable ON resumes;
DROP FUNCTION IF EXISTS prevent_career_graph_compilation_resume_mutation();

ALTER TABLE career_graph_compilations
    DROP CONSTRAINT IF EXISTS career_graph_compilations_quality_report_object,
    DROP CONSTRAINT IF EXISTS career_graph_compilations_compiler_config_values,
    DROP CONSTRAINT IF EXISTS career_graph_compilations_compiler_config_object,
    DROP COLUMN IF EXISTS quality_report,
    DROP COLUMN IF EXISTS compiler_config;

COMMIT;
