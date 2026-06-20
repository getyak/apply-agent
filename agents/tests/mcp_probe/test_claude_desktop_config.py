"""Validate the Claude Desktop config snippet in agents/mcp_probe/README.md.

If a developer copies that JSON block into ~/Library/Application Support/
Claude/claude_desktop_config.json, it must be schema-valid (Claude Desktop's
config schema only requires `mcpServers.<name>.command` plus optional `args`,
`env`, and `cwd`).

This test:
1. extracts the first ```json fenced block under "## Install + run" in the README
2. asserts it parses
3. asserts mcpServers.relay-experimental has a string command and a list of args
4. asserts the args reference `agents.mcp_probe.server` (the renamed module —
   guards against future drift if someone renames the package back to `mcp`)

The README block is the SINGLE source of truth for the snippet — keeping it
in markdown lets users copy-paste, and this test keeps it honest.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_README = (
    Path(__file__).parent.parent.parent / "mcp_probe" / "README.md"
).resolve()


def _extract_first_json_block(text: str) -> str:
    m = re.search(r"```json\s*\n(.+?)\n```", text, re.DOTALL)
    assert m, "no ```json block found in README"
    return m.group(1)


def test_readme_has_valid_claude_desktop_config() -> None:
    assert _README.exists(), f"README not found at {_README}"
    raw = _extract_first_json_block(_README.read_text(encoding="utf-8"))
    cfg = json.loads(raw)

    assert "mcpServers" in cfg, "missing mcpServers root key"
    assert "relay-experimental" in cfg["mcpServers"], (
        "Claude Desktop entry must be named 'relay-experimental' to match the "
        "server name in agents/mcp_probe/server.py::build_server"
    )

    entry = cfg["mcpServers"]["relay-experimental"]
    assert isinstance(entry["command"], str) and entry["command"], "command empty"
    assert isinstance(entry["args"], list) and entry["args"], "args empty"


def test_readme_config_points_to_renamed_module() -> None:
    """Regression: when we renamed agents/mcp → agents/mcp_probe to avoid
    shadowing the upstream `mcp` PyPI package, README config had to follow.
    If anyone reverts that, this test fires immediately."""
    raw = _extract_first_json_block(_README.read_text(encoding="utf-8"))
    cfg = json.loads(raw)
    args = cfg["mcpServers"]["relay-experimental"]["args"]
    joined = " ".join(args)
    assert "agents.mcp_probe.server" in joined, (
        f"README config does not reference agents.mcp_probe.server: {joined!r}"
    )
    assert "agents.mcp.server" not in joined, (
        f"README config still references the old shadowing path agents.mcp.server: {joined!r}"
    )
