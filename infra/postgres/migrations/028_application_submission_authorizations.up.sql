-- 028 up: short-lived, one-application authorization for a browser final click.
--
-- Relay still never submits an application server-side. This receipt records
-- that the owner typed the exact application-bound phrase immediately before
-- Codex/Claude performs one final click in the user's browser. A later
-- browser-confirmed submitted transition atomically consumes the receipt.

BEGIN;

CREATE TABLE application_submission_authorizations (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL,
    application_id              UUID NOT NULL,
    compilation_id              UUID NOT NULL,
    expected_job_url_fingerprint TEXT NOT NULL CHECK (
        expected_job_url_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    observed_url_fingerprint    TEXT NOT NULL CHECK (
        observed_url_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    confirmation_digest         TEXT NOT NULL CHECK (
        confirmation_digest ~ '^[0-9a-f]{64}$'
    ),
    authorization_source        TEXT NOT NULL DEFAULT 'codex_mcp_exact_confirmation'
        CHECK (authorization_source = 'codex_mcp_exact_confirmation'),
    authorized_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at                  TIMESTAMPTZ NOT NULL,
    consumed_at                 TIMESTAMPTZ,
    invalidated_at              TIMESTAMPTZ,
    CONSTRAINT application_submission_authorizations_owned_application_fk
        FOREIGN KEY (application_id, user_id)
        REFERENCES application_drafts(id, user_id)
        ON DELETE CASCADE,
    CONSTRAINT application_submission_authorizations_owned_compilation_fk
        FOREIGN KEY (compilation_id, user_id)
        REFERENCES career_graph_compilations(id, user_id)
        ON DELETE CASCADE,
    CHECK (expires_at > authorized_at),
    CHECK (consumed_at IS NULL OR consumed_at >= authorized_at),
    CHECK (invalidated_at IS NULL OR invalidated_at >= authorized_at),
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

CREATE INDEX idx_application_submission_authorizations_owner_time
    ON application_submission_authorizations(user_id, authorized_at DESC);

CREATE INDEX idx_application_submission_authorizations_application_time
    ON application_submission_authorizations(application_id, authorized_at DESC);

-- An expired row is invalidated in the same transaction before a replacement
-- is inserted. The index therefore prevents concurrent live receipts without
-- relying on a volatile now() expression in an index predicate.
CREATE UNIQUE INDEX idx_application_submission_authorizations_one_current
    ON application_submission_authorizations(user_id, application_id)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE OR REPLACE FUNCTION guard_application_submission_authorization_mutation()
RETURNS TRIGGER AS $$
DECLARE
    writer_name TEXT;
BEGIN
    -- Account/application/compilation privacy deletion must still cascade.
    -- The receipt has two owned parents, so either FK can be the cascade path.
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (
            SELECT 1
              FROM application_drafts
             WHERE id = OLD.application_id
               AND user_id = OLD.user_id
        ) OR NOT EXISTS (
            SELECT 1
              FROM career_graph_compilations
             WHERE id = OLD.compilation_id
               AND user_id = OLD.user_id
        ) THEN
            RETURN OLD;
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        writer_name := NULLIF(
            current_setting(
                'relay.application_submission_authorization_writer',
                true
            ),
            ''
        );

        IF (
            to_jsonb(NEW) - 'consumed_at' - 'invalidated_at'
            = to_jsonb(OLD) - 'consumed_at' - 'invalidated_at'
            AND OLD.consumed_at IS NULL
            AND OLD.invalidated_at IS NULL
            AND (
                (
                    NEW.consumed_at IS NOT NULL
                    AND NEW.invalidated_at IS NULL
                    AND writer_name = 'codex_mcp_browser_confirmation'
                )
                OR
                (
                    NEW.consumed_at IS NULL
                    AND NEW.invalidated_at IS NOT NULL
                    AND writer_name = 'codex_mcp_authorize'
                )
            )
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION
        'application submission authorization receipts are immutable'
        USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_application_submission_authorizations_guard
    BEFORE UPDATE OR DELETE ON application_submission_authorizations
    FOR EACH ROW
    EXECUTE FUNCTION guard_application_submission_authorization_mutation();

CREATE OR REPLACE FUNCTION consume_codex_application_submission_authorization()
RETURNS TRIGGER AS $$
DECLARE
    event_source TEXT;
    authorization_id_text TEXT;
    authorization_id UUID;
BEGIN
    IF OLD.status = 'submitted' OR NEW.status <> 'submitted' THEN
        RETURN NEW;
    END IF;

    event_source := NULLIF(
        current_setting('relay.application_event_source', true),
        ''
    );
    IF event_source IS DISTINCT FROM 'codex_mcp_browser_confirmation' THEN
        RETURN NEW;
    END IF;

    authorization_id_text := NULLIF(
        current_setting(
            'relay.application_submission_authorization_id',
            true
        ),
        ''
    );
    IF authorization_id_text IS NULL THEN
        RAISE EXCEPTION
            'browser-confirmed MCP submission requires an authorization receipt'
            USING ERRCODE = '23514';
    END IF;

    BEGIN
        authorization_id := authorization_id_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION
            'browser-confirmed MCP submission authorization receipt is invalid'
            USING ERRCODE = '23514';
    END;

    UPDATE application_submission_authorizations AS receipt
       SET consumed_at = transaction_timestamp()
     WHERE receipt.id = authorization_id
       AND receipt.user_id = NEW.user_id
       AND receipt.application_id = NEW.id
       AND receipt.consumed_at IS NULL
       AND receipt.invalidated_at IS NULL
       AND receipt.expires_at > clock_timestamp()
       AND EXISTS (
           SELECT 1
             FROM career_graph_compilations AS compilation
            WHERE compilation.id = receipt.compilation_id
              AND compilation.user_id = receipt.user_id
              AND compilation.resume_id = NEW.resume_version_id
              AND compilation.status IN ('approved', 'published')
       );

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'browser-confirmed MCP submission authorization is unavailable or expired'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_application_drafts_consume_submission_authorization
    BEFORE UPDATE OF status ON application_drafts
    FOR EACH ROW
    EXECUTE FUNCTION consume_codex_application_submission_authorization();

COMMENT ON TABLE application_submission_authorizations IS
    'Short-lived exact-confirmation receipts for one final click in the user browser; never a server-side submit capability.';
COMMENT ON COLUMN application_submission_authorizations.confirmation_digest IS
    'SHA-256 digest of the exact application-bound phrase; the phrase is not stored.';
COMMENT ON COLUMN application_submission_authorizations.observed_url_fingerprint IS
    'SHA-256 of the browser URL assessed immediately before authorization.';
COMMENT ON COLUMN application_submission_authorizations.invalidated_at IS
    'Set when a newer exact confirmation supersedes an unused receipt.';

COMMIT;
