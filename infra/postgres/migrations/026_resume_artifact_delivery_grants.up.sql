-- 026 up: short-lived résumé artifact delivery for browser-only applications.
--
-- Codex/Claude receive a Career Graph compilation through MCP, but the user's
-- Chrome needs a real PDF/DOCX file to upload.  Requiring public résumé
-- publication for that handoff would widen exposure unnecessarily.  These
-- grants are instead compilation-bound (and application-bound for upload),
-- expire quickly, cap downloads, and store only a SHA-256 digest of the
-- raw capability code.

BEGIN;

ALTER TABLE career_graph_compilations
    ADD CONSTRAINT career_graph_compilations_id_user_unique
        UNIQUE (id, user_id);

CREATE TABLE resume_artifact_delivery_grants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    compilation_id      UUID NOT NULL,
    application_id      UUID,
    purpose             TEXT NOT NULL CHECK (
        purpose IN ('compilation_review', 'application_upload')
    ),
    artifact_format     TEXT NOT NULL CHECK (
        artifact_format IN ('pdf', 'docx')
    ),
    token_digest        TEXT NOT NULL UNIQUE CHECK (
        token_digest ~ '^[a-f0-9]{64}$'
    ),
    expires_at          TIMESTAMPTZ NOT NULL,
    max_downloads       SMALLINT NOT NULL DEFAULT 5 CHECK (
        max_downloads BETWEEN 1 AND 10
    ),
    download_count      SMALLINT NOT NULL DEFAULT 0 CHECK (
        download_count >= 0 AND download_count <= max_downloads
    ),
    last_downloaded_at  TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT resume_artifact_grants_owned_compilation_fk
        FOREIGN KEY (compilation_id, user_id)
        REFERENCES career_graph_compilations(id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT resume_artifact_grants_owned_application_fk
        FOREIGN KEY (application_id, user_id)
        REFERENCES application_drafts(id, user_id)
        ON DELETE CASCADE,
    CHECK (
        (purpose = 'compilation_review' AND application_id IS NULL)
        OR
        (purpose = 'application_upload' AND application_id IS NOT NULL)
    ),
    CHECK (expires_at > created_at)
);

CREATE INDEX idx_resume_artifact_grants_expiry
    ON resume_artifact_delivery_grants(expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_resume_artifact_grants_application
    ON resume_artifact_delivery_grants(user_id, application_id, created_at DESC);

CREATE UNIQUE INDEX idx_resume_artifact_grants_one_current_review
    ON resume_artifact_delivery_grants(
        user_id, compilation_id, artifact_format
    )
    WHERE revoked_at IS NULL AND purpose = 'compilation_review';

CREATE UNIQUE INDEX idx_resume_artifact_grants_one_current_upload
    ON resume_artifact_delivery_grants(user_id, application_id, artifact_format)
    WHERE revoked_at IS NULL AND purpose = 'application_upload';

COMMENT ON TABLE resume_artifact_delivery_grants IS
    'Short-lived PDF/DOCX capabilities for compilation review or user-browser upload.';
COMMENT ON COLUMN resume_artifact_delivery_grants.token_digest IS
    'SHA-256 digest only; the raw download code is returned once through owner-scoped MCP.';
COMMENT ON COLUMN resume_artifact_delivery_grants.download_count IS
    'Bounded retries for browser download behavior; never an application submission signal.';

-- Keep the capability check, lifecycle gate, owner/application binding, and
-- bounded counter update in one database statement.  Hono renders only a row
-- returned by this function, so no read-then-consume race can expose a file.
CREATE FUNCTION consume_resume_artifact_delivery_grant(
    p_grant_id UUID,
    p_token_digest TEXT
)
RETURNS TABLE (
    purpose TEXT,
    artifact_format TEXT,
    content JSONB,
    version INT,
    compiler_config JSONB,
    compilation_id UUID,
    application_id UUID
)
LANGUAGE SQL
VOLATILE
STRICT
SET search_path = public
AS $$
    UPDATE resume_artifact_delivery_grants AS delivery_grant
       SET download_count = delivery_grant.download_count + 1,
           last_downloaded_at = now()
      FROM career_graph_compilations AS compilation
      JOIN resumes AS resume ON resume.id = compilation.resume_id
     WHERE delivery_grant.id = p_grant_id
       AND delivery_grant.token_digest = p_token_digest
       AND delivery_grant.compilation_id = compilation.id
       AND delivery_grant.user_id = compilation.user_id
       AND delivery_grant.revoked_at IS NULL
       AND delivery_grant.expires_at > now()
       AND delivery_grant.download_count < delivery_grant.max_downloads
       AND (
         (
           delivery_grant.purpose = 'compilation_review'
           AND delivery_grant.application_id IS NULL
           AND compilation.status IN ('draft', 'approved', 'published')
         )
         OR
         (
           delivery_grant.purpose = 'application_upload'
           AND compilation.status IN ('approved', 'published')
           AND EXISTS (
               SELECT 1
                 FROM application_drafts AS application
                WHERE application.id = delivery_grant.application_id
                  AND application.user_id = delivery_grant.user_id
                  AND application.resume_version_id = compilation.resume_id
           )
         )
       )
    RETURNING delivery_grant.purpose,
              delivery_grant.artifact_format,
              resume.content,
              resume.version,
              compilation.compiler_config,
              compilation.id,
              delivery_grant.application_id;
$$;

COMMENT ON FUNCTION consume_resume_artifact_delivery_grant(UUID, TEXT) IS
    'Atomically validates and consumes one bounded résumé artifact download.';

COMMIT;
