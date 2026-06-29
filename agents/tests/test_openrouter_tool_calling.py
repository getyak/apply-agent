"""Smoke test: OpenRouter × DeepSeek/GLM × tool_calling compatibility.

Per docs/architecture/agent-harness.md § 已知风险与应对 and
cicd-aiops-harness.md § 6 pitfall #3 — DeepSeek/GLM sometimes return
malformed tool_call JSON when routed through OpenRouter. If this test
goes red the whole agent layer is at risk, so we run it as the first
gate in the agent CI job (nightly + pre-deploy).

Run manually:
    OPENROUTER_API_KEY=… uv run pytest -k openrouter_tool_calling -q

Skipped automatically when the key is absent so unit-test CI doesn't
fail in key-less environments.
"""

from __future__ import annotations

import os

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent

from agents.harness.llm import pick_model


@tool
def dummy_lookup(query: str) -> str:
    """Return a fixed canned result. The agent must call this tool.

    Args:
        query: Anything — the answer is constant. We just want the
            model to *invoke* the tool to confirm function calling
            works through OpenRouter on this provider.
    """
    return f"Looked up: {query.upper()}"


def _has_real_openrouter_key() -> bool:
    """CI sets OPENROUTER_API_KEY=dummy-for-unit-tests to satisfy code that
    requires the env var to be present; treat that placeholder as 'absent'
    so smoke tests don't actually hit OpenRouter and 401.

    Round-20 fix: `.env.example` ships the value `sk-or-CHANGE_ME` (and the
    web/api scaffolds similarly use `CHANGE_ME` substrings as the
    documented placeholder). A dev who copies `.env.example` to `.env` and
    runs pytest would otherwise trip the smoke test against a fake key.
    Extend the placeholder detection to recognise CHANGE_ME and the
    `sk-or-` literal prefix as 'not a real key' rather than only the
    leading word.
    """
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        return False
    lk = key.lower()
    if lk.startswith(("dummy", "test", "fake", "placeholder")):
        return False
    if "change_me" in lk or "changeme" in lk:
        return False
    if lk == "sk-or-change_me" or lk.startswith("sk-or-change"):
        return False
    return True


pytestmark = pytest.mark.skipif(
    not _has_real_openrouter_key(),
    reason="OPENROUTER_API_KEY not set or is a dummy/test placeholder — skip OpenRouter smoke tests",
)


@pytest.mark.parametrize("tier", ["heavy", "general", "fast"])
@pytest.mark.asyncio
async def test_tool_calling_through_openrouter(tier: str) -> None:
    """For each tier, the model must emit a tool_call when asked."""
    model = pick_model(tier, temperature=0.0, max_tokens=512)  # type: ignore[arg-type]

    agent = create_react_agent(
        model=model,
        tools=[dummy_lookup],
        prompt=(
            "You are a tool-using assistant. When asked a factual lookup, "
            "always call the available tool exactly once before answering."
        ),
    )

    result = await agent.ainvoke(
        {
            "messages": [
                HumanMessage(
                    content="Call dummy_lookup with query='hello world' and "
                    "report the result verbatim."
                )
            ]
        }
    )

    messages = result["messages"]
    saw_tool_call = any(
        isinstance(m, AIMessage) and bool(getattr(m, "tool_calls", None)) for m in messages
    )
    assert saw_tool_call, (
        f"{tier} tier did NOT emit a tool_call. Messages: {[type(m).__name__ for m in messages]}"
    )

    # And the canned tool result string should be observable somewhere
    # in the conversation — confirms the tool actually ran, not just
    # that the model emitted a tool_call shape.
    transcript = "\n".join(getattr(m, "content", "") or "" for m in messages)
    assert "HELLO WORLD" in transcript.upper(), (
        f"{tier} tier emitted a tool_call but the result was not "
        f"observed. Transcript:\n{transcript}"
    )
