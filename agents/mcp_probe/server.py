"""stdio MCP server — Relay capabilities exposed for external agent probing.

Run: `uv run python -m agents.mcp_probe.server` (requires `experimental` extra).

This is NOT a production interface. It exists solely to answer one question:
"Can an external MCP client (Claude Desktop, Cursor, etc.) reach Relay's
existing jobmatch_agent / resume_agent via stdio MCP?"

If the answer is no → probe failed, remove agents/mcp_probe/.
If the answer is yes → record the result in docs/architecture/
agent-marketplace-deferred.md § 6, but DO NOT extend the surface. Wait for a
restart signal (§ 5 of the same doc).

Set RELAY_MCP_PROBE_FAKE=1 to run against in-memory fixtures (no PG/LLM).
This is what test_e2e.py uses to exercise the full stdio handshake in CI.
"""

from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mcp.server import Server


def _require_mcp_extra() -> None:
    """Fail loudly if `mcp` SDK isn't installed.

    The SDK is intentionally in the `experimental` extra so a default
    `uv sync` doesn't pull it. Probe operators must opt in:
        uv sync --extra dev --extra experimental
    """
    try:
        import mcp  # noqa: F401
    except ImportError:
        sys.stderr.write(
            "[relay-mcp-probe] The `mcp` package is not installed.\n"
            "  Install with: uv sync --extra dev --extra experimental\n"
            "  See docs/architecture/agent-marketplace-deferred.md § 4.\n"
        )
        sys.exit(2)


def build_server() -> Server:
    """Construct the MCP server with both tools registered.

    Factored out so test_e2e.py can spin up a fresh instance per test if
    we ever need to (today it's only invoked from _main()).
    """
    from mcp.server import Server
    from mcp.types import TextContent, Tool

    from agents.mcp_probe import tools

    server: Server = Server("relay-experimental")

    @server.list_tools()
    async def _list_tools() -> list[Tool]:
        return [
            Tool(
                name="search_jobs",
                description=(
                    "Search Relay's canonicalized job database. Probe-grade — "
                    "not for production use."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "user_id": {"type": "string"},
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="tailor_resume",
                description=(
                    "Tailor a base résumé for a JD. fabrication_guard always on; "
                    "vision.md red line cannot be bypassed via this probe."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "base_resume_id": {"type": "string"},
                        "jd_id": {"type": "string"},
                        "user_id": {"type": "string"},
                    },
                    "required": ["base_resume_id", "jd_id", "user_id"],
                },
            ),
        ]

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict) -> list[TextContent]:
        import json as _json

        if name == "search_jobs":
            result = await tools.search_jobs(**arguments)
        elif name == "tailor_resume":
            result = await tools.tailor_resume(**arguments)
        else:
            raise ValueError(f"unknown tool: {name}")
        return [TextContent(type="text", text=_json.dumps(result, ensure_ascii=False))]

    return server


async def _main() -> None:
    _require_mcp_extra()

    from mcp.server.stdio import stdio_server

    server = build_server()

    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(_main())
