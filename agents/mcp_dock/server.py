"""stdio MCP server — Relay Dock Agent capabilities for external MCP clients.

This is the production-track MCP surface. ``mcp_probe`` was a one-off
compatibility probe; this server is the long-lived interface that lets
Claude Code / Claude Desktop / Cursor invoke the same Dock-tool registry
the in-app Ask Vantage dock uses.

Run:
  uv run python -m agents.mcp_dock.server

Claude Code wiring (``~/.claude/settings.json``):
  {
    "mcpServers": {
      "relay-dock": {
        "command": "uv",
        "args": ["run", "python", "-m", "agents.mcp_dock.server"],
        "cwd": "/path/to/apply-agent/agents"
      }
    }
  }

The server requires the ``experimental`` extra (the MCP SDK is not in the
default ``uv sync`` to keep the import-time cost off the API path). Install
with ``uv sync --extra dev --extra experimental``.
"""
from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mcp.server import Server


def _require_mcp_extra() -> None:
    """Fail loudly with a friendly message if the MCP SDK isn't installed."""
    try:
        import mcp  # noqa: F401
    except ImportError:
        sys.stderr.write(
            "[relay-mcp-dock] The `mcp` package is not installed.\n"
            "  Install with: uv sync --extra dev --extra experimental\n"
        )
        sys.exit(2)


def build_server() -> Server:
    """Construct the MCP server with every tool in the dock catalog registered.

    Factored out so tests can spin up a fresh instance per case (mirrors
    ``mcp_probe.server.build_server``). The catalog is owned by
    ``mcp_dock.tools.TOOL_CATALOG`` — adding a tool there reflects here
    on the next ``build_server`` call.
    """
    from mcp.server import Server
    from mcp.types import TextContent, Tool

    from agents.mcp_dock import tools

    server: Server = Server("relay-dock")

    @server.list_tools()
    async def _list_tools() -> list[Tool]:
        return [
            Tool(
                name=spec["name"],
                description=spec["description"],
                inputSchema=spec["input_schema"],
            )
            for spec in tools.TOOL_CATALOG
        ]

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict) -> list[TextContent]:
        import json as _json

        spec = tools.find_tool(name)
        if spec is None:
            raise ValueError(f"unknown tool: {name}")
        result = await spec["func"](**arguments)
        return [
            TextContent(
                type="text",
                text=_json.dumps(result, ensure_ascii=False, default=str),
            )
        ]

    return server


async def _main() -> None:
    _require_mcp_extra()

    from mcp.server.stdio import stdio_server

    server = build_server()

    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(_main())
