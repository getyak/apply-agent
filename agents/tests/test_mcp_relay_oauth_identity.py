from __future__ import annotations

import pytest
from mcp.server.auth.provider import AccessToken

from agents.career_graph.store import CareerGraphStateError
from agents.mcp_relay import tools

USER_ID = "00000000-0000-4000-8000-000000000111"


def _access_token(*scopes: str) -> AccessToken:
    return AccessToken(
        token="not-a-real-token",
        client_id="codex-test",
        scopes=list(scopes),
        subject=USER_ID,
        resource="https://relay.example/mcp",
    )


async def test_status_explains_connect_action_when_local_identity_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RELAY_MCP_FAKE", raising=False)
    monkeypatch.delenv("RELAY_USER_ID", raising=False)
    monkeypatch.setattr(tools, "get_access_token", lambda: None)

    status = await tools.relay_status()

    assert status["ok"] is False
    assert status["identity_configured"] is False
    assert status["mode"] == "disconnected"
    assert status["authentication"]["recommended"] == "remote_oauth"
    assert status["workflow_resumable_after_authentication"] is True


async def test_oauth_subject_replaces_local_user_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RELAY_MCP_FAKE", raising=False)
    monkeypatch.delenv("RELAY_USER_ID", raising=False)
    monkeypatch.setattr(
        tools,
        "get_access_token",
        lambda: _access_token("career:read"),
    )

    seen = []

    async def store_call(name, user_id):
        assert name == "list_graphs"
        seen.append(str(user_id))
        return []

    monkeypatch.setattr(tools, "_store_call", store_call)
    status = await tools.relay_status()
    assert seen == [USER_ID]
    assert status["mode"] == "remote_oauth"
    assert status["identity_source"] == "oauth_subject"


async def test_write_tool_rejects_read_only_oauth_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RELAY_MCP_FAKE", raising=False)
    monkeypatch.delenv("RELAY_USER_ID", raising=False)
    monkeypatch.setattr(
        tools,
        "get_access_token",
        lambda: _access_token("career:read"),
    )

    with pytest.raises(CareerGraphStateError, match="career:write"):
        await tools.propose_career_graph_changes(
            operations=[],
            summary="must never reach the store",
        )


async def test_oauth_token_requires_uuid_subject(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RELAY_MCP_FAKE", raising=False)
    monkeypatch.delenv("RELAY_USER_ID", raising=False)
    invalid = _access_token("career:read").model_copy(
        update={"subject": "attacker-controlled-string"}
    )
    monkeypatch.setattr(tools, "get_access_token", lambda: invalid)

    with pytest.raises(CareerGraphStateError, match="subject must be"):
        tools.current_user_id()
