"""Unit tests for the ask_clarification dock tool — P1-4 proactive HITL.

Locks down:
  - Empty question rejected with status=error
  - Options list trimmed to 4 entries and per-entry cap 60 chars
  - placeholder + intent_hint pass through, capped
  - The function uses langgraph.types.interrupt to pause
  - Dict-shaped interrupt resume value coerced to str (text key)
  - Tool is registered in DOCK_TOOLS
"""
from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

import pytest

from agents.coordinator import dock_tools


@pytest.fixture
def _set_dock_user():
    """ask_clarification requires the dock user contextvar to be set."""
    tokens = dock_tools.set_dock_context(
        user_id=uuid4(), thread_id="ask_vantage:test", surface="dock"
    )
    yield
    dock_tools.reset_dock_context(tokens)


def test_ask_clarification_in_dock_tools():
    """The new tool must be registered so the dock LLM can call it."""
    names = {t.name for t in dock_tools.DOCK_TOOLS}
    assert "ask_clarification" in names


def test_ask_clarification_rejects_empty_question(_set_dock_user):
    out = dock_tools.ask_clarification.invoke({"question": "  "})
    assert isinstance(out, dict)
    assert out["status"] == "error"
    assert "non-empty" in out["message"]


def test_ask_clarification_interrupt_called_with_payload(_set_dock_user):
    """When called with a real question, the tool calls interrupt() with the
    structured payload and returns whatever interrupt() yields."""
    captured: list = []

    def fake_interrupt(payload):
        captured.append(payload)
        return "Stripe Staff"  # simulate user's answer

    with patch("langgraph.types.interrupt", side_effect=fake_interrupt):
        answer = dock_tools.ask_clarification.invoke(
            {
                "question": "Which job should I tailor against?",
                "options": ["Stripe Staff", "Linear PM", "Anthropic MTS"],
                "intent_hint": "job_pick",
            }
        )

    assert answer == "Stripe Staff"
    assert len(captured) == 1
    payload = captured[0]
    assert payload["kind"] == "clarification"
    assert payload["question"] == "Which job should I tailor against?"
    assert payload["options"] == ["Stripe Staff", "Linear PM", "Anthropic MTS"]
    assert payload["intent_hint"] == "job_pick"
    assert payload["placeholder"] is None


def test_ask_clarification_caps_options_to_four(_set_dock_user):
    """Defensive cap: a verbose LLM shouldn't be able to push 12 options."""
    captured: list = []

    def fake_interrupt(payload):
        captured.append(payload)
        return ""

    with patch("langgraph.types.interrupt", side_effect=fake_interrupt):
        dock_tools.ask_clarification.invoke(
            {"question": "Pick", "options": [f"opt-{i}" for i in range(12)]}
        )

    assert len(captured[0]["options"]) == 4


def test_ask_clarification_caps_option_length(_set_dock_user):
    long = "x" * 200

    def fake_interrupt(payload):
        return ""

    with patch("langgraph.types.interrupt", side_effect=fake_interrupt) as f:
        dock_tools.ask_clarification.invoke({"question": "Q", "options": [long]})
    payload = f.call_args[0][0]
    assert len(payload["options"][0]) == 60


def test_ask_clarification_caps_question_length(_set_dock_user):
    very_long = "Q" * 500

    def fake_interrupt(payload):
        return ""

    with patch("langgraph.types.interrupt", side_effect=fake_interrupt) as f:
        dock_tools.ask_clarification.invoke({"question": very_long})
    payload = f.call_args[0][0]
    assert len(payload["question"]) == 200


def test_ask_clarification_dict_resume_coerced_to_text(_set_dock_user):
    """If /ask/resume sends {value: "...", text: "..."}, prefer the text."""
    with patch(
        "langgraph.types.interrupt",
        side_effect=lambda p: {"text": "remote", "value": "ignored"},
    ):
        answer = dock_tools.ask_clarification.invoke({"question": "Where?"})
    assert answer == "remote"


def test_ask_clarification_empty_resume_returns_empty_string(_set_dock_user):
    with patch("langgraph.types.interrupt", side_effect=lambda p: None):
        answer = dock_tools.ask_clarification.invoke({"question": "Where?"})
    assert answer == ""


def test_ask_clarification_requires_dock_user_context():
    """Without set_dock_context first, the tool refuses (cheap auth boundary)."""
    with pytest.raises(RuntimeError, match="without an active user context"):
        dock_tools.ask_clarification.invoke({"question": "Q"})
