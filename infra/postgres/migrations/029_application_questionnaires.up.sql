-- 029 up: review-gated questionnaire artifacts for one application package.
--
-- application_drafts.form_answers belongs to the legacy Coordinator workflow
-- and may contain a plain answer list. Codex-native questionnaires need their
-- own versioned lifecycle so an approved résumé, browser job identity, answer
-- evidence, and human decision cannot be mixed with that legacy projection.

BEGIN;

CREATE TABLE application_questionnaires (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL,
    application_id      UUID NOT NULL,
    compilation_id      UUID NOT NULL,
    revision            INTEGER NOT NULL CHECK (revision > 0),
    status              TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'approved', 'rejected')),
    job_identity        JSONB NOT NULL
        CHECK (jsonb_typeof(job_identity) = 'object'),
    fields              JSONB NOT NULL
        CHECK (jsonb_typeof(fields) = 'array'),
    summary             JSONB NOT NULL
        CHECK (jsonb_typeof(summary) = 'object'),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at         TIMESTAMPTZ,
    approval_source     TEXT,
    CONSTRAINT application_questionnaires_owned_application_fk
        FOREIGN KEY (application_id, user_id)
        REFERENCES application_drafts(id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT application_questionnaires_owned_compilation_fk
        FOREIGN KEY (compilation_id, user_id)
        REFERENCES career_graph_compilations(id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT application_questionnaires_owner_revision_unique
        UNIQUE (user_id, application_id, revision),
    CHECK (
        (status = 'draft' AND reviewed_at IS NULL AND approval_source IS NULL)
        OR
        (
            status IN ('approved', 'rejected')
            AND reviewed_at IS NOT NULL
            AND approval_source = 'codex_mcp_exact_confirmation'
        )
    )
);

CREATE INDEX idx_application_questionnaires_owner_latest
    ON application_questionnaires(user_id, application_id, revision DESC);

CREATE UNIQUE INDEX idx_application_questionnaires_one_draft
    ON application_questionnaires(user_id, application_id)
    WHERE status = 'draft';

COMMENT ON TABLE application_questionnaires IS
    'Versioned Codex/browser questionnaire review artifacts bound to one application and approved Career Graph compilation.';
COMMENT ON COLUMN application_questionnaires.fields IS
    'Detected form fields, proposed actions and answers, confidence, sensitivity, and answer evidence.';

COMMIT;
