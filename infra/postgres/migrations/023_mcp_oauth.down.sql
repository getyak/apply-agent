-- 023 down: remove remote MCP OAuth state.

BEGIN;

DROP TABLE IF EXISTS mcp_oauth_refresh_tokens;
DROP TABLE IF EXISTS mcp_oauth_access_tokens;
DROP TABLE IF EXISTS mcp_oauth_authorization_requests;
DROP TRIGGER IF EXISTS trg_mcp_oauth_clients_updated_at ON mcp_oauth_clients;
DROP TABLE IF EXISTS mcp_oauth_clients;

COMMIT;
