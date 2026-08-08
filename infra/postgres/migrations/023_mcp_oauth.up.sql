-- 023 up: OAuth 2.1 identity for the remote Relay Career Graph MCP server.
--
-- Codex obtains a user-scoped access token through authorization code + PKCE.
-- Relay's existing web/API login remains the resource-owner authentication
-- boundary. Authorization codes and bearer/refresh tokens are stored only as
-- SHA-256 digests; the raw values exist only long enough to cross the OAuth
-- protocol boundary.

BEGIN;

CREATE TABLE mcp_oauth_clients (
    client_id         TEXT PRIMARY KEY,
    client_metadata   JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(client_metadata) = 'object')
);

CREATE TRIGGER trg_mcp_oauth_clients_updated_at
    BEFORE UPDATE ON mcp_oauth_clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE mcp_oauth_authorization_requests (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id                       TEXT NOT NULL
                                      REFERENCES mcp_oauth_clients(client_id)
                                      ON DELETE CASCADE,
    user_id                         UUID REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri                    TEXT NOT NULL,
    redirect_uri_provided_explicitly BOOLEAN NOT NULL,
    state                           TEXT,
    scopes                          TEXT[] NOT NULL,
    code_challenge                  TEXT NOT NULL,
    resource                        TEXT,
    status                          TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'denied', 'consumed')
    ),
    authorization_code_hash         CHAR(64) UNIQUE,
    authorization_code_expires_at   TIMESTAMPTZ,
    expires_at                      TIMESTAMPTZ NOT NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at                      TIMESTAMPTZ,
    consumed_at                     TIMESTAMPTZ,
    CHECK (
        (status = 'pending' AND user_id IS NULL
            AND authorization_code_hash IS NULL)
        OR
        (status = 'denied' AND user_id IS NOT NULL
            AND authorization_code_hash IS NULL)
        OR
        (status IN ('approved', 'consumed') AND user_id IS NOT NULL
            AND authorization_code_hash IS NOT NULL
            AND authorization_code_expires_at IS NOT NULL)
    )
);

CREATE INDEX idx_mcp_oauth_authorization_requests_pending
    ON mcp_oauth_authorization_requests(expires_at)
    WHERE status = 'pending';

CREATE INDEX idx_mcp_oauth_authorization_requests_code
    ON mcp_oauth_authorization_requests(authorization_code_hash)
    WHERE authorization_code_hash IS NOT NULL;

CREATE TABLE mcp_oauth_access_tokens (
    token_hash        CHAR(64) PRIMARY KEY,
    token_family_id   UUID NOT NULL,
    client_id         TEXT NOT NULL
                        REFERENCES mcp_oauth_clients(client_id)
                        ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes            TEXT[] NOT NULL,
    resource          TEXT,
    expires_at        TIMESTAMPTZ NOT NULL,
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mcp_oauth_access_tokens_family
    ON mcp_oauth_access_tokens(token_family_id);

CREATE INDEX idx_mcp_oauth_access_tokens_expiry
    ON mcp_oauth_access_tokens(expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE mcp_oauth_refresh_tokens (
    token_hash        CHAR(64) PRIMARY KEY,
    token_family_id   UUID NOT NULL,
    client_id         TEXT NOT NULL
                        REFERENCES mcp_oauth_clients(client_id)
                        ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes            TEXT[] NOT NULL,
    resource          TEXT,
    expires_at        TIMESTAMPTZ NOT NULL,
    revoked_at        TIMESTAMPTZ,
    rotated_to_hash   CHAR(64),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mcp_oauth_refresh_tokens_family
    ON mcp_oauth_refresh_tokens(token_family_id);

CREATE INDEX idx_mcp_oauth_refresh_tokens_expiry
    ON mcp_oauth_refresh_tokens(expires_at)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE mcp_oauth_clients IS
    'Dynamically registered MCP OAuth clients. Metadata may contain a server-generated client secret, never a user or job-platform credential.';
COMMENT ON TABLE mcp_oauth_authorization_requests IS
    'Short-lived PKCE authorization requests approved through the authenticated Relay web UI.';
COMMENT ON TABLE mcp_oauth_access_tokens IS
    'User-scoped MCP bearer tokens stored only as SHA-256 digests.';
COMMENT ON TABLE mcp_oauth_refresh_tokens IS
    'Rotating MCP refresh tokens stored only as SHA-256 digests and revoked by family.';

COMMIT;
