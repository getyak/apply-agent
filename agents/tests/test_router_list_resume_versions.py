"""Regression tests for the ``list_resume_versions`` read intent.

Background
----------
2026-06-22 user feedback: "查看一下简历版本" was routed (via the Layer 2
LLM classifier) to ``update_resume`` and surfaced a HITL artifact card
("Résumé update queued / Open résumé / Tweak in studio") that asked the
user to jump to /app/studio/resume. The user pushed back: read-only
questions must be answered inline.

These tests guard the fix so the regression can't sneak back:

  - "查看 / show / list / which versions" land on ``list_resume_versions``
    via the cheap regex (Layer 1), never on ``update_resume``.
  - ``dispatch`` for ``list_resume_versions`` returns a smalltalk-shaped
    payload (``agent: "coordinator", action: "reply", text: ...``) so the
    TS gateway takes the inline-text path and skips ``buildArtifact``.
  - ``format_resume_versions_reply`` renders Chinese when the user wrote
    CJK, English otherwise, and degrades gracefully when the user has
    zero résumés yet.
"""
from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch
from uuid import uuid4

import pytest

from agents.coordinator.router import (
    Intent,
    cheap_intent_classifier,
    dispatch,
    format_resume_versions_reply,
)

# ───────────────────────────────────────────────────────────────────────
# Layer 1 regex
# ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "message",
    [
        "查看一下简历版本",
        "查看我的简历",
        "看一下简历版本",
        "看看简历历史",
        "列出我的简历",
        "显示简历版本列表",
        "我有几版简历",
        "我一共存了多少份简历",
        "show me my résumés",
        "show my resume versions",
        "list my résumés",
        "view all resume versions",
        "what résumé versions do I have",
        "which resume versions do I have",
        "résumé history",
        "résumé timeline",
    ],
)
def test_read_phrasing_lands_on_list_intent(message: str) -> None:
    """Regex Layer 1 must catch these — no Layer 2 LLM call needed."""
    result = cheap_intent_classifier(message)
    assert result is not None, f"regex missed: {message!r}"
    assert result.intent == "list_resume_versions", (
        f"{message!r} routed to {result.intent!r}, expected list_resume_versions"
    )
    assert result.confidence >= 0.85, result.confidence


@pytest.mark.parametrize(
    "message",
    [
        "update my résumé",
        "edit my resume",
        "change my résumé email",
        "fix my résumé title",
    ],
)
def test_update_phrasing_still_lands_on_update(message: str) -> None:
    """Make sure adding list_resume_versions didn't accidentally steal
    the write path."""
    result = cheap_intent_classifier(message)
    assert result is not None
    assert result.intent == "update_resume", (
        f"{message!r} routed to {result.intent!r}, expected update_resume"
    )


# ───────────────────────────────────────────────────────────────────────
# Reply formatter — text rendering
# ───────────────────────────────────────────────────────────────────────


def _row(version: int, *, is_base: bool, days_ago: int = 0, job: str | None = None) -> dict:
    return {
        "version": version,
        "is_base": is_base,
        "tailored_for_job": job,
        "created_at": datetime(2026, 6, 22 - days_ago, tzinfo=UTC),
        "owner_name": "Xiong",
        "headline": "Engineer",
    }


def test_format_empty_chinese() -> None:
    text = format_resume_versions_reply([], has_cjk=True)
    assert "还没有" in text
    assert "上传" in text


def test_format_empty_english() -> None:
    text = format_resume_versions_reply([], has_cjk=False)
    assert "don't have" in text.lower()
    assert "upload" in text.lower()


def test_format_chinese_with_versions() -> None:
    rows = [
        _row(7, is_base=True, days_ago=0),
        _row(6, is_base=False, days_ago=2, job=str(uuid4())),
        _row(5, is_base=True, days_ago=5),
    ]
    text = format_resume_versions_reply(rows, has_cjk=True)
    assert "3 个简历版本" in text
    assert "当前主版本 v7" in text
    assert "历史主版本 v5" in text
    assert "针对岗位定制的版本" in text


def test_format_english_with_versions() -> None:
    rows = [
        _row(3, is_base=True, days_ago=0),
        _row(2, is_base=False, days_ago=1, job=str(uuid4())),
        _row(1, is_base=True, days_ago=10),
    ]
    text = format_resume_versions_reply(rows, has_cjk=False)
    assert "3 résumé version" in text
    assert "Current master v3" in text
    assert "Older master v1" in text
    assert "Tailored variants" in text


# ───────────────────────────────────────────────────────────────────────
# Dispatch — payload shape
# ───────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_returns_reply_shape_so_ts_skips_artifact() -> None:
    """Dispatch must return ``action="reply"`` for list_resume_versions so
    the TS gateway streams it as inline text and never builds the
    "Open résumé / Tweak in studio" artifact card.
    """
    user_id = uuid4()
    intent = Intent(
        intent="list_resume_versions", confidence=0.92, args={}, via="regex"
    )

    rows = [_row(4, is_base=True, days_ago=0), _row(3, is_base=True, days_ago=3)]
    with patch(
        "agents.coordinator.router.load_resume_versions",
        autospec=True,
        return_value=rows,
    ):
        result = await dispatch(intent, user_id=user_id, message="查看简历版本")

    # The key invariant: TS routes on (agent, action). Anything that isn't
    # (coordinator, reply) hits buildArtifact and re-introduces the card.
    assert result["agent"] == "coordinator"
    assert result["action"] == "reply"
    # Text is non-empty so the dock has something to render.
    assert isinstance(result.get("text"), str) and result["text"]
    assert "2" in result["text"]  # mentions the count
    # Audit trace of the original intent — kept for analytics, ignored by
    # the TS gateway.
    assert result.get("source_action") == "list_resume_versions"
    assert result["count"] == 2


@pytest.mark.asyncio
async def test_dispatch_handles_empty_resume_list() -> None:
    """No résumés → still smalltalk-shaped, no artifact, friendly prompt."""
    user_id = uuid4()
    intent = Intent(
        intent="list_resume_versions", confidence=0.92, args={}, via="regex"
    )

    with patch(
        "agents.coordinator.router.load_resume_versions",
        autospec=True,
        return_value=[],
    ):
        result = await dispatch(intent, user_id=user_id, message="show my résumés")

    assert result["agent"] == "coordinator"
    assert result["action"] == "reply"
    assert "upload" in result["text"].lower() or "build" in result["text"].lower()
    assert result["count"] == 0
