"""Probe import smoke — agents.mcp_probe must import without the `mcp` SDK extra.

Renamed from `agents/mcp/` to `agents/mcp_probe/` to avoid shadowing the
upstream `mcp` PyPI package (the SDK's own top-level module). See
docs/architecture/agent-marketplace-deferred.md § 4.
"""
from __future__ import annotations


def test_probe_package_imports() -> None:
    import agents.mcp_probe  # noqa: F401
    from agents.mcp_probe import tools  # noqa: F401
