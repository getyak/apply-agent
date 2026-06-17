-- 006: Application domain tables

CREATE TABLE application_drafts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'review', 'submitted', 'interview', 'rejected', 'offer', 'withdrawn'
    )),
    resume_version_id UUID REFERENCES resumes(id) ON DELETE SET NULL,
    cover_letter    TEXT,
    form_answers    JSONB DEFAULT '{}',
    submitted_at    TIMESTAMPTZ,
    submitted_via   TEXT CHECK (submitted_via IN ('client_extension', 'api', 'manual', 'email')),
    outcome         TEXT,
    outcome_notes   TEXT,
    interview_date  DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_apps_user ON application_drafts(user_id, status);
CREATE INDEX idx_apps_job ON application_drafts(job_id);

CREATE TRIGGER trg_apps_updated_at
    BEFORE UPDATE ON application_drafts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
