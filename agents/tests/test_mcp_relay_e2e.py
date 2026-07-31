"""Protocol-level proof that a native Codex MCP client sees the safe surface."""

from __future__ import annotations

import os
import sys

import pytest

pytest.importorskip("mcp.client.stdio")


def _params():
    from mcp.client.stdio import StdioServerParameters

    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "agents.mcp_relay.server"],
        env={**os.environ, "RELAY_MCP_FAKE": "1"},
    )


async def test_initialize_lists_review_gated_tools_without_user_id() -> None:
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    async with stdio_client(_params()) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            assert initialized.serverInfo.name == "relay-career"
            assert "Career Graph is the source of truth" in initialized.instructions

            listed = await session.list_tools()
            by_name = {tool.name: tool for tool in listed.tools}
            assert {
                "relay_status",
                "list_source_resumes",
                "propose_resume_import",
                "get_career_graph_evidence_report",
                "propose_career_graph_changes",
                "approve_career_graph_change",
                "compile_resume_for_jd",
                "approve_resume_compilation",
                "create_application_draft",
                "prepare_application_batch",
                "publish_resume_compilation",
                "prepare_application_handoff",
            }.issubset(by_name)
            for tool in listed.tools:
                assert "user_id" not in tool.inputSchema.get("properties", {})

            assert by_name["relay_status"].annotations.readOnlyHint is True
            assert by_name["publish_resume_compilation"].annotations.openWorldHint is True


async def test_status_round_trip_returns_structured_content() -> None:
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    async with stdio_client(_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("relay_status", {})
            assert result.isError is False
            assert result.structuredContent is not None
            assert result.structuredContent["server"] == "relay-career"
            assert result.structuredContent["server_side_submission"] is False
