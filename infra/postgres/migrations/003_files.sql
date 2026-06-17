-- 003: User file system tables

CREATE TABLE user_files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    filename        TEXT NOT NULL,
    storage_key     TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    checksum_sha256 TEXT,
    file_type       TEXT NOT NULL CHECK (file_type IN (
        'resume_original', 'resume_parsed', 'cover_letter',
        'transcript', 'recording', 'attachment', 'export'
    )),
    linked_resume_id UUID,
    linked_job_id    UUID,
    metadata        JSONB DEFAULT '{}',
    is_deleted      BOOLEAN NOT NULL DEFAULT false,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, path)
);

CREATE INDEX idx_user_files_user ON user_files(user_id) WHERE is_deleted = false;
CREATE INDEX idx_user_files_type ON user_files(user_id, file_type) WHERE is_deleted = false;

CREATE TABLE user_file_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id         UUID NOT NULL REFERENCES user_files(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    storage_key     TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    change_note     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(file_id, version)
);
