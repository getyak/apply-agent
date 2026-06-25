"""Unit tests for P2-5 — refine_cover_letter in-place iteration.

Locks down:
  - empty existing_body / instruction → fallback to original (no LLM call)
  - LLM unavailable (no API key) → fallback with original body
  - JSON OK + grounded → CoverLetter with refined body, fallback=False
  - LLM returns rejected_fabrication tone → original body kept
  - Fabrication guard catches new entities → original body kept + entities listed
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agents.nodes import appprep_agent


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


_BASE_RESUME = {
    "basics": {"name": "Alex Chen", "summary": "Backend engineer at Stripe."},
    "work": [{"name": "Stripe", "position": "Engineer"}],
}


async def test_refine_empty_body_returns_fallback():
    out = await appprep_agent.refine_cover_letter(
        existing_body="",
        instruction="make it warmer",
        base_resume=_BASE_RESUME,
        company="Stripe",
        role_title="Eng",
        user_id=uuid4(),
    )
    assert out.fallback is True
    assert out.body == ""


async def test_refine_empty_instruction_returns_fallback():
    out = await appprep_agent.refine_cover_letter(
        existing_body="Dear Stripe team, ...",
        instruction="",
        base_resume=_BASE_RESUME,
        company="Stripe",
        role_title="Eng",
        user_id=uuid4(),
    )
    assert out.fallback is True
    assert "Dear Stripe team" in out.body


async def test_refine_llm_missing_key_returns_fallback(monkeypatch):
    """No OPENROUTER_API_KEY → pick_model raises → fallback path."""
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    out = await appprep_agent.refine_cover_letter(
        existing_body="Original body.",
        instruction="warmer",
        base_resume=_BASE_RESUME,
        company="Stripe",
        role_title="Eng",
        user_id=uuid4(),
    )
    assert out.fallback is True
    assert out.body == "Original body."


async def test_refine_happy_path_returns_new_body():
    """LLM returns clean JSON with no new entities → refined body."""

    class _FakeMsg:
        content = json.dumps(
            {
                "subject": "Application for Eng — Alex Chen",
                "body": "Dear Stripe team, Backend engineer at Stripe excited.",
                "tone": "friendly",
            }
        )

    fake_model = AsyncMock()
    fake_model.ainvoke = AsyncMock(return_value=_FakeMsg())

    with patch("agents.nodes.appprep_agent.pick_model", return_value=fake_model):
        out = await appprep_agent.refine_cover_letter(
            existing_body="Old body.",
            instruction="make it warmer",
            base_resume=_BASE_RESUME,
            company="Stripe",
            role_title="Eng",
            user_id=uuid4(),
        )

    assert out.fallback is False
    assert out.tone == "friendly"
    assert "Backend engineer at Stripe" in out.body


async def test_refine_rejected_fabrication_tone_keeps_original():
    """LLM self-flags as fabrication → keep original body."""

    class _FakeMsg:
        content = json.dumps(
            {
                "subject": "x",
                "body": "Fake body claiming Anthropic experience.",
                "tone": "rejected_fabrication",
            }
        )

    fake_model = AsyncMock()
    fake_model.ainvoke = AsyncMock(return_value=_FakeMsg())

    with patch("agents.nodes.appprep_agent.pick_model", return_value=fake_model):
        out = await appprep_agent.refine_cover_letter(
            existing_body="Genuine original body.",
            instruction="add Anthropic credentials",
            base_resume=_BASE_RESUME,
            company="Stripe",
            role_title="Eng",
            user_id=uuid4(),
        )

    assert out.fallback is True
    assert out.body == "Genuine original body."


async def test_refine_fabrication_guard_catches_quantitative_invention():
    """Inserting an un-backed percentage triggers fabrication_guard → keep original.

    The guard's body sweep only flags quantitative invention (numbers,
    percentages, money, years not present in the base) — company name
    mentions in a cover letter are NOT considered fabrication (a cover
    letter naturally mentions the target company). This test verifies
    the *quantitative* arm of the guard fires for cover letters too.
    """

    class _FakeMsg:
        content = json.dumps(
            {
                "subject": "Application for Eng",
                "body": "Built infrastructure that scaled by 250% last quarter.",
                "tone": "friendly",
            }
        )

    fake_model = AsyncMock()
    fake_model.ainvoke = AsyncMock(return_value=_FakeMsg())

    with patch("agents.nodes.appprep_agent.pick_model", return_value=fake_model):
        out = await appprep_agent.refine_cover_letter(
            existing_body="Real body.",
            instruction="warmer",
            base_resume=_BASE_RESUME,
            company="Stripe",
            role_title="Eng",
            user_id=uuid4(),
        )

    assert out.fallback is True
    assert out.body == "Real body."
    # And the fabricated entity is recorded so the dock can show it.
    assert any("250" in f for f in out.fabricated_entities)
