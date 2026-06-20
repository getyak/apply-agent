# Relay MCP Probe (Experimental — Not for Production)

> **Status**: hidden probe. Not shipped, not in `system-overview.md`, not in `CLAUDE.md`.
> Designed to be deleted if it fails. See `docs/architecture/agent-marketplace-deferred.md` for the full context.

## What this is

A stdio MCP server that wraps Relay's existing `jobmatch_agent` and `resume_agent` as MCP tools. Built to answer **one question**:

> Can an external MCP client (Claude Desktop, Cursor) call Relay's capabilities through MCP?

That's it. It does NOT implement an A2A marketplace, agent identity, billing, or any of the things a real marketplace needs. Those decisions are deferred — see § 5 of the deferred doc for the restart signals.

## Why it's hidden

24 of 25 claims from the 2026-06-21 deep-research workflow failed adversarial verification. A2A recruiter-candidate marketplaces are a pre-2026 frontier with no validated case studies. Writing a full design doc on that basis would create long-term debt.

But there IS one cheap, low-risk move: prove that Relay's existing harness can be exposed via MCP. That's what this probe does. Success here is necessary (but not sufficient) for any future marketplace.

## Install + run

```bash
# Install BOTH dev and experimental extras (mcp SDK ships in experimental).
# Keep them paired so `uv sync` doesn't drop pytest.
cd agents/
uv sync --extra dev --extra experimental

# Run as stdio MCP server (live mode — needs PG 5433 + Redis 6380 + OpenRouter)
uv run python -m agents.mcp_probe.server

# Or in fake mode (no infra needed — same env the e2e tests use)
RELAY_MCP_PROBE_FAKE=1 uv run python -m agents.mcp_probe.server
```

Hook it into Claude Desktop by adding to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "relay-experimental": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/apply-agent/agents", "run", "python", "-m", "agents.mcp_probe.server"]
    }
  }
}
```

## Tests

```bash
cd agents/

# Default suite (cheap, hermetic — runs in CI):
uv run pytest tests/mcp_probe/ -v
# 13 tests: smoke / unit (tools) / stdio MCP handshake / Claude Desktop config validator.

# Live e2e (OpenRouter + LangGraph + MCP stdio — costs ~$0.0001):
uv run pytest tests/mcp_probe/ -v -m smoke
```

The default suite spawns a real subprocess running the stdio server, completes
the MCP `initialize → list_tools → call_tool` handshake, and parses both
tools' JSON payloads. It auto-skips if the `experimental` extra is absent.

The `-m smoke` opt-in suite drives a LangGraph `create_react_agent` (with an
OpenRouter fast-tier model) through `langchain-mcp-adapters` to call the MCP
tools end-to-end — this is the closest in-CI proxy for "Claude Desktop using
Relay via MCP".

## Bench

```bash
cd agents/
uv run python -m agents.mcp_probe.bench fake     # N=10, no LLM, transport overhead only
uv run python -m agents.mcp_probe.bench live     # N=3, real OpenRouter ReAct loop
uv run python -m agents.mcp_probe.bench both     # both
```

Latest results captured in
`docs/architecture/agent-marketplace-deferred.md` § 6 (bench 测量结果).

## Manual verification (Claude Desktop)

The stdio e2e + live e2e cover the same protocol path Claude Desktop uses;
the in-CI suite is what we rely on for regression protection. If you want
to verify hands-on:

1. `cd agents/ && uv sync --extra dev --extra experimental`
2. Replace `/absolute/path/to/apply-agent/agents` in the JSON config above
   with the real path on your machine.
3. Drop the JSON block into
   `~/Library/Application Support/Claude/claude_desktop_config.json`
   (merge with `mcpServers` if you already have one).
4. Restart Claude Desktop. Open a new chat, type "list your tools" — Claude
   should mention `search_jobs` and `tailor_resume`.
5. Try `Use search_jobs to find backend roles, with fake mode on`.
   Set `RELAY_MCP_PROBE_FAKE=1` in the config's `env` field if you don't have
   PG running.

The config snippet is schema-validated by
`tests/mcp_probe/test_claude_desktop_config.py` — if you edit it here, the
test must still pass (or update the test).

## Pass / fail criteria

See `docs/architecture/agent-marketplace-deferred.md` § 4.3 and § 4.4.

**Fail** (any one → delete `agents/mcp_probe/`):
- MCP stdio transport + OpenRouter tool calling don't compose cleanly
- Wrapper implementation exceeds 1 working day
- Latency p50 > 5s/call or cost > $0.01/call

**Pass** (all three → record in deferred-doc § 6, do NOT extend):
- Claude Desktop / Cursor lists both tools (or our stdio e2e proves they can)
- Tool calls return valid results
- Latency p50 < 3s, cost < $0.005/call

## Why `mcp_probe` not `mcp`?

The upstream MCP SDK ships its top-level package as `mcp`. If we named this
directory `agents/mcp/`, Python's import resolver would shadow the SDK
(`import mcp` would resolve to `agents/mcp/__init__.py`). The rename is
purely a naming-collision fix; nothing else about the probe's purpose
changes.

## Red lines (inherited from vision.md)

- No tool exposed here may bypass `fabrication_guard` (resume_agent.customize keeps it on)
- No tool exposed here may execute `@requires_approval` actions (no `submit_form`, no `send_email`)
- No password / credential handling
- No server-side delivery (client-side execution architecture stands)
