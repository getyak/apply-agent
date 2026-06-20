"""Protocol-level e2e — spawn a real stdio MCP server subprocess, do the full
MCP handshake from a client, list tools, call both tools, parse results.

This is THE e2e test for the probe. If it passes, an external MCP client
(Claude Desktop, Cursor, etc.) can also reach Relay via the same protocol.

Requires the `experimental` extra (mcp SDK). Skipped automatically if absent
so a default `uv sync` doesn't break.

RELAY_MCP_PROBE_FAKE=1 is set on the subprocess env so neither the test nor
the server needs PG / Redis / OpenRouter to be running.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

pytest.importorskip(
    "mcp.client.stdio",
    reason="mcp SDK not installed — run `uv sync --extra dev --extra experimental`",
)


def _params():
    from mcp.client.stdio import StdioServerParameters

    env = {**os.environ, "RELAY_MCP_PROBE_FAKE": "1"}
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "agents.mcp_probe.server"],
        env=env,
    )


async def test_e2e_initialize_and_list_tools() -> None:
    """Round-trip: initialize → list_tools → both tools present with schemas."""
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    async with stdio_client(_params()) as (read, write):
        async with ClientSession(read, write) as session:
            init_result = await session.initialize()
            assert init_result.serverInfo.name == "relay-experimental"

            tools_result = await session.list_tools()
            names = {t.name for t in tools_result.tools}
            assert names == {"search_jobs", "tailor_resume"}

            search_tool = next(t for t in tools_result.tools if t.name == "search_jobs")
            assert "query" in search_tool.inputSchema["required"]

            tailor_tool = next(t for t in tools_result.tools if t.name == "tailor_resume")
            assert set(tailor_tool.inputSchema["required"]) == {
                "base_resume_id",
                "jd_id",
                "user_id",
            }


async def test_e2e_call_search_jobs() -> None:
    """Round-trip: initialize → call_tool('search_jobs') → parse JSON payload."""
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    async with stdio_client(_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("search_jobs", {"query": "backend"})
            assert not result.isError
            assert len(result.content) >= 1
            payload = json.loads(result.content[0].text)
            assert "jobs" in payload
            titles = {j["role_title"] for j in payload["jobs"]}
            assert "Senior Backend Engineer" in titles


async def test_e2e_call_tailor_resume() -> None:
    """Round-trip: call_tool('tailor_resume') with fake mode → ok=True payload."""
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    async with stdio_client(_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(
                "tailor_resume",
                {
                    "base_resume_id": "00000000-0000-0000-0000-000000000001",
                    "jd_id": "00000000-0000-0000-0000-000000000a01",
                    "user_id": "00000000-0000-0000-0000-000000000999",
                },
            )
            assert not result.isError
            payload = json.loads(result.content[0].text)
            assert payload["ok"] is True
            assert payload["fabricated"] == []
            assert payload["via"] == "fake"
            assert payload["tailored"]["work"][0]["name"] == "Acme Corp"
