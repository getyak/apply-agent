"""Unit tests for the P2-2 tailor-quality upgrades.

Locks down:
  - fabrication_guard token-set check rejects multi-word inventions
    ("Stripe Capital" when base only has "Stripe")
  - fabrication_guard accepts subset names ("Anthropic" vs "anthropic.com")
  - Quantitative checks still verbatim (5% never matches "50%")
  - polish_bullet tool: rejects invalid resume_id
  - polish_bullet tool: requires non-empty instruction + bullet id
  - polish_bullet tool: surfaces resume_agent.propose_bullet_edit result
  - polish_bullet registered in DOCK_TOOLS
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agents.coordinator import dock_tools
from agents.nodes.resume_agent import _tokenize, fabrication_guard

# ─────────────────────────────────────────────────────────────────────
# Tokenizer
# ─────────────────────────────────────────────────────────────────────


def test_tokenize_keeps_meaningful_words():
    out = _tokenize("Built Python and TypeScript services at Stripe (5 yrs)")
    assert {"built", "python", "typescript", "services", "stripe", "yrs"} <= out
    # short tokens (≤ 2 chars) dropped
    assert "at" not in out
    assert "5" not in out


def test_tokenize_lowercases_and_keeps_techy_chars():
    out = _tokenize("Used C++ and Node.js")
    # The tokenizer requires ≥3 chars total, so multi-char techy names
    # survive (c++, node.js). 2-char names (c#, go) would be dropped —
    # the trade-off keeps noise tokens like "is", "at", "of" out.
    assert "c++" in out
    assert "node.js" in out


# ─────────────────────────────────────────────────────────────────────
# fabrication_guard
# ─────────────────────────────────────────────────────────────────────


def test_fab_guard_flags_multi_word_invention():
    """Tailored 'Stripe Capital' when base only mentions 'Stripe' must flag."""
    base = {"work": [{"name": "Stripe", "position": "Engineer"}]}
    tailored = {"work": [{"name": "Stripe Capital", "position": "Engineer"}]}
    fab = fabrication_guard(base, tailored)
    assert any(item.startswith("company:Stripe Capital") for item in fab)


def test_fab_guard_accepts_subset_name():
    """Tailored 'Anthropic' is grounded when base mentions 'Anthropic Inc'."""
    base = {"work": [{"name": "Anthropic Inc", "position": "MTS"}]}
    tailored = {"work": [{"name": "Anthropic", "position": "MTS"}]}
    fab = fabrication_guard(base, tailored)
    company_flags = [f for f in fab if f.startswith("company:")]
    assert company_flags == []


def test_fab_guard_grounds_exact_match():
    base = {"work": [{"name": "Stripe", "position": "Engineer"}]}
    tailored = {"work": [{"name": "Stripe", "position": "Engineer"}]}
    assert fabrication_guard(base, tailored) == []


def test_fab_guard_still_strict_on_quantitative():
    """A percentage that didn't exist in base must still be flagged."""
    base = {
        "work": [{"name": "Stripe", "position": "Eng", "highlights": ["Did stuff."]}]
    }
    tailored = {
        "work": [
            {"name": "Stripe", "position": "Eng", "highlights": ["Grew revenue 50%."]}
        ]
    }
    fab = fabrication_guard(base, tailored)
    assert any("percent:50%" in f for f in fab)


def test_fab_guard_grounds_when_percentage_in_base():
    base = {
        "work": [
            {"name": "Stripe", "position": "Eng", "highlights": ["Grew traffic 50%."]}
        ]
    }
    tailored = {
        "work": [
            {
                "name": "Stripe",
                "position": "Eng",
                "highlights": ["Drove conversion 50% lift."],
            }
        ]
    }
    fab = fabrication_guard(base, tailored)
    assert not any(f.startswith("percent:") for f in fab)


def test_fab_guard_position_token_check():
    """Tailored title 'Staff Backend Engineer' grounded by 'Senior Backend Engineer'?
    NO — 'staff' is a fresh token; should flag."""
    base = {"work": [{"name": "X", "position": "Senior Backend Engineer"}]}
    tailored = {"work": [{"name": "X", "position": "Staff Backend Engineer"}]}
    fab = fabrication_guard(base, tailored)
    assert any("position:Staff Backend Engineer" in f for f in fab)


# ─────────────────────────────────────────────────────────────────────
# polish_bullet dock tool
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def _set_dock_user():
    tokens = dock_tools.set_dock_context(
        user_id=uuid4(), thread_id="ask_vantage:test", surface="dock"
    )
    yield
    dock_tools.reset_dock_context(tokens)


def test_polish_bullet_registered_in_dock_tools():
    names = {t.name for t in dock_tools.DOCK_TOOLS}
    assert "polish_bullet" in names


async def test_polish_bullet_rejects_invalid_resume_id(_set_dock_user):
    out = await dock_tools.polish_bullet.ainvoke(
        {
            "resume_id": "not-a-uuid",
            "bullet_stable_id": "b1",
            "instruction": "make it sharper",
        }
    )
    assert out["status"] == "error"
    assert "invalid" in out["message"]


async def test_polish_bullet_rejects_empty_instruction(_set_dock_user):
    out = await dock_tools.polish_bullet.ainvoke(
        {
            "resume_id": str(uuid4()),
            "bullet_stable_id": "b1",
            "instruction": "  ",
        }
    )
    assert out["status"] == "error"
    assert "instruction" in out["message"]


async def test_polish_bullet_rejects_empty_bullet_id(_set_dock_user):
    out = await dock_tools.polish_bullet.ainvoke(
        {
            "resume_id": str(uuid4()),
            "bullet_stable_id": "",
            "instruction": "sharper",
        }
    )
    assert out["status"] == "error"
    assert "bullet_stable_id" in out["message"]


async def test_polish_bullet_forwards_to_resume_agent_and_unwraps(_set_dock_user):
    fake_result = {
        "ok": True,
        "id": str(uuid4()),
        "before": "Old text.",
        "after": "Sharper text.",
        "change_type": "tighten",
    }
    with patch(
        "agents.nodes.resume_agent.propose_bullet_edit",
        new=AsyncMock(return_value=fake_result),
    ) as mocked:
        out = await dock_tools.polish_bullet.ainvoke(
            {
                "resume_id": str(uuid4()),
                "bullet_stable_id": "b-123",
                "instruction": "make it tighter",
            }
        )
    mocked.assert_called_once()
    assert out["status"] == "ok"
    assert out["agent"] == "resume_agent"
    assert out["action"] == "polish_bullet"
    assert out["suggestion"]["after"] == "Sharper text."


async def test_polish_bullet_surfaces_rejection(_set_dock_user):
    fake_result = {"ok": False, "reason": "would_fabricate"}
    with patch(
        "agents.nodes.resume_agent.propose_bullet_edit",
        new=AsyncMock(return_value=fake_result),
    ):
        out = await dock_tools.polish_bullet.ainvoke(
            {
                "resume_id": str(uuid4()),
                "bullet_stable_id": "b-1",
                "instruction": "make it claim 50% growth (no source)",
            }
        )
    assert out["status"] == "rejected"
    assert out["reason"] == "would_fabricate"
