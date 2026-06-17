-- 004: Resume domain tables (JSON Resume schema)

CREATE TABLE resumes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    content         JSONB NOT NULL,
    is_base         BOOLEAN NOT NULL DEFAULT false,
    label           TEXT,
    tailored_for_job UUID,
    source_file_id  UUID REFERENCES user_files(id) ON DELETE SET NULL,
    optimization_log JSONB,
    embedding       vector(1536),
    parent_version  UUID REFERENCES resumes(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, version)
);

CREATE INDEX idx_resumes_user ON resumes(user_id);
CREATE INDEX idx_resumes_base ON resumes(user_id) WHERE is_base = true;
CREATE INDEX idx_resumes_embedding ON resumes
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- backfill FK after both tables exist
ALTER TABLE user_files
    ADD CONSTRAINT fk_files_resume FOREIGN KEY (linked_resume_id)
    REFERENCES resumes(id) ON DELETE SET NULL;
