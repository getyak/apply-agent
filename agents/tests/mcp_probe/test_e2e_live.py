"""Live e2e — OpenRouter model + LangGraph create_react_agent + MCP stdio tools.

This is the SINGLE test that validates the full agent-harness composition:

    OpenRouter LLM → LangGraph ReAct loop → langchain-mcp-adapters
                  → MCP stdio transport → Relay MCP probe server
                  → agents.mcp_probe.tools.search_jobs (fake fixture)
                  → back through MCP → ReAct loop continues → final answer

If this passes, the probe's claim "external agents can use Relay via MCP" is
backed by an actual external-agent invocation (LangGraph + OpenRouter), not
just a raw protocol handshake.

Marks:
  smoke — costs real OpenRouter tokens (~$0.001 per run). CI deselects via
          `-m "not smoke"`; developers opt in with OPENROUTER_API_KEY set.
"""

from __future__ import annotations

import os
import sys

import pytest

pytest.importorskip(
    "mcp.client.stdio",
    reason="mcp SDK not installed — run `uv sync --extra dev --extra experimental`",
)
pytest.importorskip(
    "langchain_mcp_adapters",
    reason="langchain-mcp-adapters not installed — install the experimental extra",
)


def _has_real_openrouter_key() -> bool:
    """Same logic as test_openrouter_tool_calling._has_real_openrouter_key:
    CI's dummy-for-unit-tests placeholder counts as 'absent' so we don't
    actually hit OpenRouter and 401."""
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        return False
    return not key.lower().startswith(("dummy", "test", "fake", "placeholder"))


pytestmark = [
    pytest.mark.smoke,
    pytest.mark.skipif(
        not _has_real_openrouter_key(),
        reason="OPENROUTER_API_KEY not set or is a dummy/test placeholder — live e2e needs real OpenRouter",
    ),
]


async def test_live_react_agent_calls_mcp_tool() -> None:
    """A ReAct agent driven by OpenRouter's fast tier decides to call
    `search_jobs` via MCP and returns a coherent answer derived from the
    fake fixture."""
    from langchain_mcp_adapters.client import MultiServerMCPClient
    from langgraph.prebuilt import create_react_agent

    from agents.harness.llm import pick_model

    client = MultiServerMCPClient(
        {
            "relay": {
                "command": sys.executable,
                "args": ["-m", "agents.mcp_probe.server"],
                "transport": "stdio",
                "env": {**os.environ, "RELAY_MCP_PROBE_FAKE": "1"},
            }
        }
    )
    tools = await client.get_tools()

    tool_names = {t.name for t in tools}
    assert tool_names == {"search_jobs", "tailor_resume"}, tool_names

    model = pick_model("fast", temperature=0.0, max_tokens=512)

    agent = create_react_agent(
        model=model,
        tools=tools,
        prompt=(
            "You are a job-search assistant. When the user asks about jobs, "
            "you MUST call the search_jobs tool. Then summarize the results "
            "in one short sentence."
        ),
    )

    result = await agent.ainvoke(
        {
            "messages": [
                (
                    "user",
                    "Find me backend engineering jobs. Call the tool, then summarize.",
                )
            ]
        }
    )

    messages = result["messages"]
    tool_calls = [m for m in messages if getattr(m, "tool_calls", None) and len(m.tool_calls) > 0]
    assert tool_calls, f"agent never called a tool. messages={messages!r}"

    final = messages[-1]
    text = (final.content or "").lower() if hasattr(final, "content") else ""
    assert any(co in text for co in ("stripe", "linear", "backend")), (
        f"final answer didn't reference fake jobs. final={final!r}"
    )
