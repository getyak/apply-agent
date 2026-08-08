"""PostgreSQL-backed OAuth 2.1 provider for the remote Relay MCP server.

Relay's existing web session authenticates the resource owner. This module
owns only the MCP protocol state: dynamic clients, PKCE authorization codes,
short-lived bearer tokens, rotating refresh tokens, and revocation.

Raw authorization codes and tokens are never persisted. PostgreSQL stores a
SHA-256 digest so a database read cannot be turned directly into MCP access.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from uuid import UUID, uuid4

import psycopg
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    TokenError,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

ACCESS_TOKEN_TTL = timedelta(hours=1)
REFRESH_TOKEN_TTL = timedelta(days=30)
AUTHORIZATION_REQUEST_TTL = timedelta(minutes=10)
AUTHORIZATION_CODE_TTL = timedelta(minutes=5)

ALL_SCOPES = [
    "career:read",
    "career:write",
    "resume:publish",
    "application:prepare",
]


class RelayRefreshToken(RefreshToken):
    """Refresh token with its RFC 8707 resource preserved across rotation."""

    resource: str | None = None


def _dsn() -> str:
    value = os.environ.get("RELAY_PG_DSN", "").strip()
    if not value:
        raise RuntimeError("RELAY_PG_DSN is required for remote MCP OAuth")
    return value


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _new_secret(prefix: str) -> str:
    # token_urlsafe(48) carries 384 bits before encoding, comfortably above
    # OAuth's 128-bit minimum for authorization credentials.
    return f"{prefix}{secrets.token_urlsafe(48)}"


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _epoch(value: datetime) -> int:
    return int(value.timestamp())


def _coerce_json(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value


async def _insert_token_pair(
    cur: psycopg.AsyncCursor[Any],
    *,
    client_id: str,
    user_id: UUID,
    scopes: list[str],
    resource: str | None,
    family_id: UUID,
) -> OAuthToken:
    now = _utcnow()
    access_token = _new_secret("relay_at_")
    refresh_token = _new_secret("relay_rt_")
    await cur.execute(
        """
        INSERT INTO mcp_oauth_access_tokens (
            token_hash, token_family_id, client_id, user_id, scopes,
            resource, expires_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            _digest(access_token),
            str(family_id),
            client_id,
            str(user_id),
            scopes,
            resource,
            now + ACCESS_TOKEN_TTL,
        ),
    )
    await cur.execute(
        """
        INSERT INTO mcp_oauth_refresh_tokens (
            token_hash, token_family_id, client_id, user_id, scopes,
            resource, expires_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            _digest(refresh_token),
            str(family_id),
            client_id,
            str(user_id),
            scopes,
            resource,
            now + REFRESH_TOKEN_TTL,
        ),
    )
    return OAuthToken(
        access_token=access_token,
        token_type="Bearer",
        expires_in=int(ACCESS_TOKEN_TTL.total_seconds()),
        scope=" ".join(scopes),
        refresh_token=refresh_token,
    )


class PostgresOAuthProvider(
    OAuthAuthorizationServerProvider[
        AuthorizationCode,
        RelayRefreshToken,
        AccessToken,
    ]
):
    """FastMCP OAuth provider whose user consent is completed by Relay Web."""

    def __init__(
        self,
        *,
        web_base_url: str,
        issuer_url: str,
    ) -> None:
        self.web_base_url = web_base_url.rstrip("/")
        self.issuer_url = issuer_url.rstrip("/")

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT client_metadata
                      FROM mcp_oauth_clients
                     WHERE client_id = %s
                    """,
                    (client_id,),
                )
                row = await cur.fetchone()
        if not row:
            return None
        return OAuthClientInformationFull.model_validate(_coerce_json(row[0]))

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if not client_info.client_id:
            raise ValueError("OAuth client_id is required")
        payload = json.dumps(client_info.model_dump(mode="json"), separators=(",", ":"))
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO mcp_oauth_clients (client_id, client_metadata)
                    VALUES (%s, %s::jsonb)
                    ON CONFLICT (client_id) DO UPDATE
                        SET client_metadata = EXCLUDED.client_metadata
                    """,
                    (client_info.client_id, payload),
                )
            await conn.commit()

    async def authorize(
        self,
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
    ) -> str:
        if not client.client_id:
            raise ValueError("OAuth client_id is required")
        expires_at = _utcnow() + AUTHORIZATION_REQUEST_TTL
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO mcp_oauth_authorization_requests (
                        client_id, redirect_uri,
                        redirect_uri_provided_explicitly, state, scopes,
                        code_challenge, resource, expires_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        client.client_id,
                        str(params.redirect_uri),
                        params.redirect_uri_provided_explicitly,
                        params.state,
                        params.scopes or [],
                        params.code_challenge,
                        params.resource,
                        expires_at,
                    ),
                )
                row = await cur.fetchone()
            await conn.commit()
        if not row:
            raise RuntimeError("failed to create MCP authorization request")
        query = urlencode({"request_id": str(row[0])})
        return f"{self.web_base_url}/auth/mcp?{query}"

    async def load_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: str,
    ) -> AuthorizationCode | None:
        if not client.client_id:
            return None
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT scopes, authorization_code_expires_at, client_id,
                           code_challenge, redirect_uri,
                           redirect_uri_provided_explicitly, resource, user_id
                      FROM mcp_oauth_authorization_requests
                     WHERE authorization_code_hash = %s
                       AND client_id = %s
                       AND status = 'approved'
                       AND authorization_code_expires_at > now()
                    """,
                    (_digest(authorization_code), client.client_id),
                )
                row = await cur.fetchone()
        if not row:
            return None
        return AuthorizationCode(
            code=authorization_code,
            scopes=list(row[0]),
            expires_at=row[1].timestamp(),
            client_id=row[2],
            code_challenge=row[3],
            redirect_uri=row[4],
            redirect_uri_provided_explicitly=row[5],
            resource=row[6],
            subject=str(row[7]),
        )

    async def exchange_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: AuthorizationCode,
    ) -> OAuthToken:
        if not client.client_id:
            raise TokenError("invalid_client", "OAuth client_id is required")
        code_hash = _digest(authorization_code.code)
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT user_id, scopes, resource
                      FROM mcp_oauth_authorization_requests
                     WHERE authorization_code_hash = %s
                       AND client_id = %s
                       AND status = 'approved'
                       AND authorization_code_expires_at > now()
                     FOR UPDATE
                    """,
                    (code_hash, client.client_id),
                )
                row = await cur.fetchone()
                if not row:
                    raise TokenError(
                        "invalid_grant",
                        "authorization code is expired, consumed, or invalid",
                    )
                await cur.execute(
                    """
                    UPDATE mcp_oauth_authorization_requests
                       SET status = 'consumed', consumed_at = now()
                     WHERE authorization_code_hash = %s
                    """,
                    (code_hash,),
                )
                token = await _insert_token_pair(
                    cur,
                    client_id=client.client_id,
                    user_id=UUID(str(row[0])),
                    scopes=list(row[1]),
                    resource=row[2],
                    family_id=uuid4(),
                )
            await conn.commit()
        return token

    async def load_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: str,
    ) -> RelayRefreshToken | None:
        if not client.client_id:
            return None
        token_hash = _digest(refresh_token)
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT token_family_id, client_id, user_id, scopes, resource,
                           expires_at, revoked_at
                      FROM mcp_oauth_refresh_tokens
                     WHERE token_hash = %s AND client_id = %s
                    """,
                    (token_hash, client.client_id),
                )
                row = await cur.fetchone()
                if row and row[6] is not None:
                    # Reuse of a rotated refresh token invalidates the complete
                    # family, limiting replay after credential theft.
                    await cur.execute(
                        """
                        UPDATE mcp_oauth_access_tokens
                           SET revoked_at = COALESCE(revoked_at, now())
                         WHERE token_family_id = %s
                        """,
                        (str(row[0]),),
                    )
                    await cur.execute(
                        """
                        UPDATE mcp_oauth_refresh_tokens
                           SET revoked_at = COALESCE(revoked_at, now())
                         WHERE token_family_id = %s
                        """,
                        (str(row[0]),),
                    )
                    await conn.commit()
        if not row or row[6] is not None or row[5] <= _utcnow():
            return None
        return RelayRefreshToken(
            token=refresh_token,
            client_id=row[1],
            scopes=list(row[3]),
            expires_at=_epoch(row[5]),
            subject=str(row[2]),
            resource=row[4],
        )

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RelayRefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        if not client.client_id:
            raise TokenError("invalid_client", "OAuth client_id is required")
        old_hash = _digest(refresh_token.token)
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT token_family_id, user_id, scopes, resource,
                           expires_at, revoked_at
                      FROM mcp_oauth_refresh_tokens
                     WHERE token_hash = %s AND client_id = %s
                     FOR UPDATE
                    """,
                    (old_hash, client.client_id),
                )
                row = await cur.fetchone()
                if not row or row[5] is not None or row[4] <= _utcnow():
                    raise TokenError(
                        "invalid_grant",
                        "refresh token is expired, rotated, or invalid",
                    )
                granted_scopes = list(row[2])
                if any(scope not in granted_scopes for scope in scopes):
                    raise TokenError(
                        "invalid_scope",
                        "requested scope exceeds the original grant",
                    )

                family_id = UUID(str(row[0]))
                # Rotate both credentials. Old access tokens in the same
                # family stop working as soon as a refresh succeeds.
                await cur.execute(
                    """
                    UPDATE mcp_oauth_access_tokens
                       SET revoked_at = COALESCE(revoked_at, now())
                     WHERE token_family_id = %s
                    """,
                    (str(family_id),),
                )
                new_token = await _insert_token_pair(
                    cur,
                    client_id=client.client_id,
                    user_id=UUID(str(row[1])),
                    scopes=scopes,
                    resource=row[3],
                    family_id=family_id,
                )
                if not new_token.refresh_token:
                    raise RuntimeError("refresh rotation did not create a refresh token")
                await cur.execute(
                    """
                    UPDATE mcp_oauth_refresh_tokens
                       SET revoked_at = now(), rotated_to_hash = %s
                     WHERE token_hash = %s
                    """,
                    (_digest(new_token.refresh_token), old_hash),
                )
            await conn.commit()
        return new_token

    async def load_access_token(self, token: str) -> AccessToken | None:
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT client_id, user_id, scopes, resource, expires_at
                      FROM mcp_oauth_access_tokens
                     WHERE token_hash = %s
                       AND revoked_at IS NULL
                       AND expires_at > now()
                    """,
                    (_digest(token),),
                )
                row = await cur.fetchone()
        if not row:
            return None
        return AccessToken(
            token=token,
            client_id=row[0],
            scopes=list(row[2]),
            expires_at=_epoch(row[4]),
            resource=row[3],
            subject=str(row[1]),
            claims={"iss": self.issuer_url},
        )

    async def revoke_token(
        self,
        token: AccessToken | RelayRefreshToken,
    ) -> None:
        token_hash = _digest(token.token)
        async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT token_family_id
                      FROM mcp_oauth_access_tokens
                     WHERE token_hash = %s
                    UNION ALL
                    SELECT token_family_id
                      FROM mcp_oauth_refresh_tokens
                     WHERE token_hash = %s
                    LIMIT 1
                    """,
                    (token_hash, token_hash),
                )
                row = await cur.fetchone()
                if row:
                    await cur.execute(
                        """
                        UPDATE mcp_oauth_access_tokens
                           SET revoked_at = COALESCE(revoked_at, now())
                         WHERE token_family_id = %s
                        """,
                        (str(row[0]),),
                    )
                    await cur.execute(
                        """
                        UPDATE mcp_oauth_refresh_tokens
                           SET revoked_at = COALESCE(revoked_at, now())
                         WHERE token_family_id = %s
                        """,
                        (str(row[0]),),
                    )
            await conn.commit()
