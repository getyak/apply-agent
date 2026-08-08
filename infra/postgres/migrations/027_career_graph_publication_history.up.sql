-- 027 up: stable, review-gated Career Graph publication versions.
--
-- Compiled résumé rows remain immutable. Updating a public résumé transfers
-- the same publish token from one approved compilation row to another, so the
-- URL stays stable while the old artifact and its outcome attribution remain
-- intact. This table records every observed publish/update/revoke transition
-- without storing the bearer token itself.

BEGIN;

ALTER TABLE career_graphs
    ADD CONSTRAINT career_graphs_id_user_unique UNIQUE (id, user_id);

ALTER TABLE resumes
    ADD CONSTRAINT resumes_id_user_unique UNIQUE (id, user_id);

ALTER TABLE career_graph_compilations
    ADD CONSTRAINT career_graph_compilations_owned_resume_fk
        FOREIGN KEY (resume_id, user_id)
        REFERENCES resumes(id, user_id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT career_graph_compilations_id_graph_user_unique
        UNIQUE (id, graph_id, user_id);

CREATE TABLE career_graph_publication_events (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL,
    graph_id                UUID NOT NULL,
    event_kind              TEXT NOT NULL CHECK (
        event_kind IN ('baseline', 'published', 'updated', 'revoked')
    ),
    event_source            TEXT NOT NULL CHECK (
        char_length(event_source) BETWEEN 1 AND 64
    ),
    from_compilation_id     UUID,
    to_compilation_id       UUID,
    public_token_digest     TEXT NOT NULL CHECK (
        public_token_digest ~ '^[0-9a-f]{64}$'
    ),
    occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT career_graph_publication_events_owned_graph_fk
        FOREIGN KEY (graph_id, user_id)
        REFERENCES career_graphs(id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT career_graph_publication_events_from_compilation_fk
        FOREIGN KEY (from_compilation_id, graph_id, user_id)
        REFERENCES career_graph_compilations(id, graph_id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT career_graph_publication_events_to_compilation_fk
        FOREIGN KEY (to_compilation_id, graph_id, user_id)
        REFERENCES career_graph_compilations(id, graph_id, user_id)
        ON DELETE CASCADE,
    CHECK (
        (
            event_kind IN ('baseline', 'published')
            AND from_compilation_id IS NULL
            AND to_compilation_id IS NOT NULL
        )
        OR (
            event_kind = 'updated'
            AND from_compilation_id IS NOT NULL
            AND to_compilation_id IS NOT NULL
            AND from_compilation_id <> to_compilation_id
        )
        OR (
            event_kind = 'revoked'
            AND from_compilation_id IS NOT NULL
            AND to_compilation_id IS NULL
        )
    )
);

CREATE INDEX idx_career_graph_publication_events_owner_time
    ON career_graph_publication_events(user_id, occurred_at DESC);

CREATE INDEX idx_career_graph_publication_events_graph_time
    ON career_graph_publication_events(graph_id, occurred_at DESC);

-- Existing active Career Graph links are observations, not newly witnessed
-- publishes. Backfill them as explicit baselines and hash the current token.
INSERT INTO career_graph_publication_events (
    user_id,
    graph_id,
    event_kind,
    event_source,
    from_compilation_id,
    to_compilation_id,
    public_token_digest,
    occurred_at
)
SELECT
    compilation.user_id,
    compilation.graph_id,
    'baseline',
    'migration_backfill',
    NULL,
    compilation.id,
    encode(digest(resume.publish_token, 'sha256'), 'hex'),
    COALESCE(compilation.published_at, resume.published_at, now())
FROM career_graph_compilations compilation
JOIN resumes resume ON resume.id = compilation.resume_id
WHERE resume.publish_token IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_career_graph_publication_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    -- Account/graph privacy deletion must still cascade. Direct event changes
    -- remain forbidden while the owner graph exists.
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1
          FROM career_graphs
         WHERE id = OLD.graph_id
           AND user_id = OLD.user_id
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION
        'Career Graph publication history is append-only'
        USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_career_graph_publication_events_immutable
    BEFORE UPDATE OR DELETE ON career_graph_publication_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_career_graph_publication_event_mutation();

CREATE OR REPLACE FUNCTION require_career_graph_publication_writer()
RETURNS TRIGGER AS $$
DECLARE
    writer_name TEXT;
BEGIN
    IF OLD.publish_token IS NOT DISTINCT FROM NEW.publish_token OR NOT EXISTS (
        SELECT 1
          FROM career_graph_compilations
         WHERE resume_id = OLD.id
           AND user_id = OLD.user_id
    ) THEN
        RETURN NEW;
    END IF;

    writer_name := NULLIF(
        current_setting('relay.career_graph_publication_writer', true),
        ''
    );
    IF writer_name IS NULL OR writer_name NOT IN (
            'codex_mcp_publish',
            'codex_mcp_update',
            'codex_mcp_revoke'
        ) THEN
        RAISE EXCEPTION
            'Career Graph publication changes require the review-gated publication workflow'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_career_graph_publication_writer
    BEFORE UPDATE OF publish_token ON resumes
    FOR EACH ROW
    EXECUTE FUNCTION require_career_graph_publication_writer();

COMMENT ON TABLE career_graph_publication_events IS
    'Append-only owner-scoped history for stable Career Graph public résumé links.';
COMMENT ON COLUMN career_graph_publication_events.public_token_digest IS
    'SHA-256 digest for correlating one stable link without storing its bearer token.';

COMMIT;
