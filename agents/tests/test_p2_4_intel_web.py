"""Unit tests for P2-4 — interview intel web fallback.

Locks down:
  - _intel_from_web returns None when company missing
  - empty search hits → honest "no public data yet" brief, no fabrication
  - good hits → LLM extraction → structured IntelBrief
  - JSON parse failure → fallback "couldn't parse" brief, never raises
  - fetch_intel(crowdsourced) falls back to web when pool is empty
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from agents.nodes import interview_agent


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    monkeypatch.delenv("RELAY_REDIS_URL", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)


async def test_intel_from_web_returns_none_without_company():
    out = await interview_agent._intel_from_web(None, None, None)
    assert out is None


async def test_intel_from_web_empty_search_returns_honest_brief():
    """No search hits → brief with empty questions, message says so."""
    with patch(
        "agents.tools.web.web_search",
        new=AsyncMock(return_value={"status": "ok", "results": []}),
    ):
        brief = await interview_agent._intel_from_web("Anthropic", "MTS", None)
    assert brief is not None
    assert brief["frequent_questions"] == []
    assert "No public write-ups" in brief["interviewer_style"]


async def test_intel_from_web_extracts_questions_from_hits():
    """With good hits + working LLM, we get a structured brief."""
    fake_search = {
        "status": "ok",
        "source": "duckduckgo",
        "results": [
            {
                "title": "Anthropic interview process — Reddit",
                "url": "https://reddit.com/r/x/post",
                "snippet": "Phone screen had coding then ML basics.",
            },
            {
                "title": "Glassdoor Anthropic Engineer",
                "url": "https://glassdoor.com/x",
                "snippet": "Lots of system design and AI safety questions.",
            },
        ],
    }

    fake_llm_response = json.dumps(
        {
            "interviewer_style": "Mix of coding + safety alignment.",
            "frequent_questions": [
                {"q": "Walk through a system you designed.", "probability": 0.7, "trap": False},
                {"q": "How do you think about model safety?", "probability": 0.6, "trap": False},
            ],
            "jd_real_focus": ["distributed systems", "safety"],
        }
    )

    class _FakeMsg:
        def __init__(self, content):
            self.content = content

    fake_model = AsyncMock()
    fake_model.ainvoke = AsyncMock(return_value=_FakeMsg(fake_llm_response))

    with (
        patch("agents.tools.web.web_search", new=AsyncMock(return_value=fake_search)),
        patch("agents.nodes.interview_agent.pick_model", return_value=fake_model),
    ):
        brief = await interview_agent._intel_from_web("Anthropic", "MTS", "phone_screen")

    assert brief["interviewer_style"] == "Mix of coding + safety alignment."
    assert len(brief["frequent_questions"]) == 2
    assert brief["frequent_questions"][0]["q"].startswith("Walk through")
    assert brief["jd_real_focus"] == ["distributed systems", "safety"]


async def test_intel_from_web_parse_failure_is_safe():
    """LLM returns garbage → fallback brief, no exception."""
    fake_search = {
        "status": "ok",
        "results": [
            {
                "title": "X",
                "url": "https://x.example",
                "snippet": "some snippet",
            }
        ],
    }

    class _FakeMsg:
        content = "not json {{{"

    fake_model = AsyncMock()
    fake_model.ainvoke = AsyncMock(return_value=_FakeMsg())

    with (
        patch("agents.tools.web.web_search", new=AsyncMock(return_value=fake_search)),
        patch("agents.nodes.interview_agent.pick_model", return_value=fake_model),
    ):
        brief = await interview_agent._intel_from_web("X", None, None)

    assert brief is not None
    assert brief["frequent_questions"] == []
    assert "couldn't parse" in brief["interviewer_style"]


async def test_intel_from_web_strips_markdown_code_fence():
    """LLM wrapping JSON in ```json ... ``` must still parse."""
    fake_search = {
        "status": "ok",
        "results": [{"title": "t", "url": "u", "snippet": "s"}],
    }

    class _FakeMsg:
        content = (
            "```json\n"
            '{"interviewer_style": "ok", '
            '"frequent_questions": [{"q": "Q1", "probability": 0.5, "trap": false}], '
            '"jd_real_focus": ["a"]}\n'
            "```"
        )

    fake_model = AsyncMock()
    fake_model.ainvoke = AsyncMock(return_value=_FakeMsg())

    with (
        patch("agents.tools.web.web_search", new=AsyncMock(return_value=fake_search)),
        patch("agents.nodes.interview_agent.pick_model", return_value=fake_model),
    ):
        brief = await interview_agent._intel_from_web("X", None, None)

    assert brief is not None
    assert brief["interviewer_style"] == "ok"
    assert len(brief["frequent_questions"]) == 1


async def test_fetch_intel_crowdsourced_falls_back_to_web():
    """crowdsourced strategy: empty pool → web fallback used."""
    mode = {
        "intel_strategy": "crowdsourced",
        "pressure_level": "encourage_only",
        "feedback_style": "one_line_per_answer",
        "loop_kind": "standalone",
        "slug": "scene_recreation",
    }

    empty_pool_brief = {
        "round_minutes": 30,
        "interviewer_style": "No data",
        "frequent_questions": [],
        "jd_real_focus": [],
    }
    web_brief = {
        "round_minutes": 45,
        "interviewer_style": "From the web.",
        "frequent_questions": [{"q": "Web Q1", "probability": 0.6, "trap": False}],
        "jd_real_focus": ["web focus"],
    }

    with (
        patch(
            "agents.nodes.interview_agent._intel_from_pool",
            new=AsyncMock(return_value=empty_pool_brief),
        ),
        patch(
            "agents.nodes.interview_agent._intel_from_web",
            new=AsyncMock(return_value=web_brief),
        ),
        patch("agents.nodes.interview_agent.redis_get", new=AsyncMock(return_value=None)),
        patch("agents.nodes.interview_agent.redis_setex", new=AsyncMock(return_value=None)),
    ):
        brief = await interview_agent.fetch_intel(
            company="Anthropic", role="MTS", round_type=None, mode=mode
        )

    assert brief is not None
    assert brief["interviewer_style"] == "From the web."
    assert brief["frequent_questions"][0]["q"] == "Web Q1"


async def test_fetch_intel_crowdsourced_keeps_pool_when_not_empty():
    """If pool returns data, don't make a web call."""
    mode = {
        "intel_strategy": "crowdsourced",
        "pressure_level": "encourage_only",
        "feedback_style": "one_line_per_answer",
        "loop_kind": "standalone",
        "slug": "scene_recreation",
    }
    pool_brief = {
        "round_minutes": 30,
        "interviewer_style": "From pool",
        "frequent_questions": [{"q": "Pool Q", "probability": 0.7, "trap": False}],
        "jd_real_focus": [],
    }
    web_call = AsyncMock()

    with (
        patch(
            "agents.nodes.interview_agent._intel_from_pool",
            new=AsyncMock(return_value=pool_brief),
        ),
        patch("agents.nodes.interview_agent._intel_from_web", new=web_call),
        patch("agents.nodes.interview_agent.redis_get", new=AsyncMock(return_value=None)),
        patch("agents.nodes.interview_agent.redis_setex", new=AsyncMock(return_value=None)),
    ):
        brief = await interview_agent.fetch_intel(
            company="Anthropic", role="MTS", round_type=None, mode=mode
        )

    assert brief["frequent_questions"][0]["q"] == "Pool Q"
    web_call.assert_not_called()
