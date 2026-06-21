"""Smoke test for the relay-dock MCP server stdio handshake.

Mirrors the ``mcp_probe/tests/test_smoke.py`` pattern: skipped when the
``mcp`` SDK isn't installed (default ``uv sync`` doesn't pull it). When
present, builds the server and verifies:
  - ``list_tools`` returns the full TOOL_CATALOG
  - ``call_tool`` round-trips a propose_plan call and returns one
    TextContent with valid JSON
  - Unknown tool names surface as an error (either raised or via
    isError flag, depending on SDK version)
"""
from __future__ import annotations

import json
from uuid import uuid4

import pytest

pytest.importorskip(
    "mcp",
    reason="mcp SDK not installed — run `uv sync --extra dev --extra experimental`",
)


def _get_registered_handler(server, schema_class_name: str):
    """Find the handler the @server.list_tools / @server.call_tool decorators registered."""
    import mcp.types as t

    cls = getattr(t, schema_class_name)
    return server.request_handlers.get(cls)


@pytest.mark.asyncio
async def test_build_server_registers_full_catalog():
    import mcp.types as t

    from agents.mcp_dock.server import build_server
    from agents.mcp_dock.tools import TOOL_CATALOG

    server = build_server()
    handler = _get_registered_handler(server, "ListToolsRequest")
    assert handler is not None, "list_tools handler not registered"

    req = t.ListToolsRequest(method="tools/list", params=None)
    result = await handler(req)
    payload = getattr(result, "root", result)
    names = {tool.name for tool in payload.tools}
    expected = {spec["name"] for spec in TOOL_CATALOG}
    assert names == expected, (
        f"catalog mismatch: {expected - names} vs {names - expected}"
    )


@pytest.mark.asyncio
async def test_call_tool_round_trips_propose_plan():
    import mcp.types as t

    from agents.mcp_dock.server import build_server

    server = build_server()
    handler = _get_registered_handler(server, "CallToolRequest")
    assert handler is not None

    uid = str(uuid4())
    req = t.CallToolRequest(
        method="tools/call",
        params=t.CallToolRequestParams(
            name="propose_plan",
            arguments={
                "user_id": uid,
                "user_goal": "MCP smoke test",
                "steps": [
                    {
                        "step": "smoke",
                        "agent": "coordinator",
                        "label": "ok",
                        "requires_review": False,
                    }
                ],
            },
        ),
    )
    result = await handler(req)
    payload = getattr(result, "root", result)
    contents = payload.content
    assert len(contents) == 1
    assert contents[0].type == "text"
    parsed = json.loads(contents[0].text)
    assert parsed["status"] == "ok"
    assert parsed["plan"][0]["agent"] == "coordinator"


@pytest.mark.asyncio
async def test_call_unknown_tool_raises():
    import mcp.types as t

    from agents.mcp_dock.server import build_server

    server = build_server()
    handler = _get_registered_handler(server, "CallToolRequest")
    req = t.CallToolRequest(
        method="tools/call",
        params=t.CallToolRequestParams(name="bogus_tool", arguments={}),
    )
    try:
        result = await handler(req)
    except ValueError as exc:
        assert "bogus_tool" in str(exc)
        return
    payload = getattr(result, "root", result)
    assert getattr(payload, "isError", False), (
        f"expected error response for unknown tool, got {payload}"
    )
