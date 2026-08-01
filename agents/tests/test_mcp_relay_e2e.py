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
                "list_resume_compilations",
                "list_tracked_applications",
                "propose_resume_import",
                "get_career_graph_evidence_report",
                "propose_career_graph_changes",
                "approve_career_graph_change",
                "compile_resume_for_jd",
                "approve_resume_compilation",
                "prepare_resume_artifact_review",
                "assess_application_browser_checkpoint",
                "create_application_draft",
                "record_application_progress",
                "prepare_application_batch",
                "publish_resume_compilation",
                "update_published_resume",
                "revoke_published_resume",
                "get_resume_publication_history",
                "prepare_application_handoff",
            }.issubset(by_name)
            for tool in listed.tools:
                assert "user_id" not in tool.inputSchema.get("properties", {})

            compiler_schema = by_name["compile_resume_for_jd"].inputSchema["properties"]
            assert compiler_schema["artifact_locale"]["enum"] == ["en", "zh"]
            assert compiler_schema["length_budget"]["enum"] == ["one_page", "two_page"]
            assert compiler_schema["ats_profile"]["enum"] == ["standard", "strict"]
            progress_schema = by_name["record_application_progress"].inputSchema["properties"]
            assert progress_schema["evidence_source"]["enum"] == [
                "user_reported",
                "browser_confirmation",
                "recruiter_message",
            ]
            assert "submitted" in progress_schema["status"]["enum"]
            assert "accepted" in progress_schema["status"]["enum"]
            handoff_schema = by_name["prepare_application_handoff"].inputSchema["properties"]
            assert handoff_schema["artifact_format"]["enum"] == ["pdf", "docx"]
            review_schema = by_name["prepare_resume_artifact_review"].inputSchema["properties"]
            assert review_schema["artifact_format"]["enum"] == ["pdf", "docx"]
            assert by_name["relay_status"].annotations.readOnlyHint is True
            assert by_name["list_resume_compilations"].annotations.readOnlyHint is True
            assert by_name["list_tracked_applications"].annotations.readOnlyHint is True
            assert by_name["publish_resume_compilation"].annotations.openWorldHint is True
            assert by_name["update_published_resume"].annotations.openWorldHint is True
            assert by_name["revoke_published_resume"].annotations.destructiveHint is True
            assert by_name["get_resume_publication_history"].annotations.readOnlyHint is True
            assert by_name["prepare_resume_artifact_review"].annotations.readOnlyHint is False
            assert by_name["prepare_resume_artifact_review"].annotations.openWorldHint is True
            assert by_name["prepare_application_handoff"].annotations.readOnlyHint is False
            assert by_name["prepare_application_handoff"].annotations.openWorldHint is True


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
