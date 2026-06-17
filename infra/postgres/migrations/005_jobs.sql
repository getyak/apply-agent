-- 005: Job domain tables

CREATE TABLE jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL CHECK (source IN ('greenhouse', 'lever', 'ashby', 'manual', 'other')),
    external_id     TEXT,
    company         TEXT NOT NULL,
    role_title      TEXT NOT NULL,
    jd_text         TEXT,
    url             TEXT,
    posted_date     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    parsed          JSONB DEFAULT '{}',
    embedding       vector(1536),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source, external_id)
);

CREATE INDEX idx_jobs_active ON jobs(is_active, posted_date DESC) WHERE is_active = true;
CREATE INDEX idx_jobs_company ON jobs(company);
CREATE INDEX idx_jobs_embedding ON jobs
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- backfill FKs
ALTER TABLE resumes
    ADD CONSTRAINT fk_resumes_job FOREIGN KEY (tailored_for_job)
    REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE user_files
    ADD CONSTRAINT fk_files_job FOREIGN KEY (linked_job_id)
    REFERENCES jobs(id) ON DELETE SET NULL;
