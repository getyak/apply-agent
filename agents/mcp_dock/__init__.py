"""relay-dock MCP server — Dock Agent capabilities for external MCP clients.

This is the production-track MCP surface for Relay. Unlike ``mcp_probe``
(which was a one-off compatibility probe), this server exposes the
``agents.coordinator.dock_tools`` registry so Claude Code, Claude Desktop,
or any other MCP client can drive the same plan-first + tool-use loop
the Ask Vantage dock runs in-app.

Why two MCP servers:
  - ``mcp_probe`` answered "does MCP stdio work at all here?" That probe
    succeeded; the file stays for regression coverage but isn't extended.
  - ``mcp_dock`` answers "can an external operator (you, in Claude Code)
    invoke the Vantage agent stack without going through the web UI?"
    Yes — and this is the API surface for it.

Run:
  uv run python -m agents.mcp_dock.server
"""
