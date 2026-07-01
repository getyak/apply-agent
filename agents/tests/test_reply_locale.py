"""Tests for the reply_locale detector and the post-hoc enforcement path.

Covers the layer that decides what language a dock reply lands in:

  - ``detect_reply_locale`` picks the language of the LATEST user message,
    falls back to the UI locale on short / ambiguous text, and never
    raises on broken inputs.
  - ``reply_language_directive`` shape lock so a downstream prompt-render
    change surfaces loudly.
  - The interview-agent's post-hoc enforcer translates only fields that
    are long enough AND in the wrong language.
"""

from __future__ import annotations

import pytest

from agents.harness.locale import (
    detect_reply_locale,
    reply_language_directive,
)

# ── detect_reply_locale ────────────────────────────────────────────────


def test_long_english_message_returns_en_even_when_ui_is_zh():
    msg = (
        "What is the time complexity of quicksort, and how do I optimise "
        "it for nearly-sorted data without falling into O(n^2) on adversarial input?"
    )
    assert detect_reply_locale(msg, ui_locale_fallback="zh") == "en"


def test_long_chinese_message_returns_zh_even_when_ui_is_en():
    msg = "帮我分析一下这份简历的弱点，特别是工作经历部分的量化指标和技术栈描述"
    assert detect_reply_locale(msg, ui_locale_fallback="en") == "zh"


def test_short_message_falls_back_to_ui_locale_zh():
    assert detect_reply_locale("hi", ui_locale_fallback="zh") == "zh"


def test_short_message_falls_back_to_ui_locale_en():
    assert detect_reply_locale("ok", ui_locale_fallback="en") == "en"


def test_empty_message_falls_back_to_ui_locale():
    assert detect_reply_locale("", ui_locale_fallback="zh") == "zh"


def test_chinese_dominant_mixed_message_returns_zh():
    msg = "帮我 review 这段 TypeScript 代码，看看有没有 race condition 的问题"
    assert detect_reply_locale(msg, ui_locale_fallback="en") == "zh"


def test_english_dominant_mixed_message_returns_en():
    msg = (
        "Please review this 简历 and tell me the three weakest spots in detail, "
        "with specific bullet rewrites and quantification suggestions."
    )
    assert detect_reply_locale(msg, ui_locale_fallback="zh") == "en"


def test_emoji_only_message_falls_back_to_ui_locale():
    msg = "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉"
    assert detect_reply_locale(msg, ui_locale_fallback="zh") == "zh"


def test_url_only_message_falls_back_to_ui_locale():
    msg = "https://example.com/posts/123 https://github.com/foo/bar"
    assert detect_reply_locale(msg, ui_locale_fallback="zh") == "zh"


def test_code_fence_does_not_bias_detection_toward_english():
    """A short Chinese question with a big English code block should NOT
    get classified as English just because the code is longer."""
    msg = (
        "这段代码有什么问题吗？\n"
        "```\n"
        "function thisHasALotOfEnglishIdentifiersAndComments(input) {\n"
        "  // long english comment that would normally swamp the detector\n"
        "  return input.split(' ').map(s => s.toUpperCase()).join('-');\n"
        "}\n"
        "```"
    )
    assert detect_reply_locale(msg, ui_locale_fallback="zh") == "zh"


def test_missing_ui_locale_defaults_to_english():
    assert detect_reply_locale("ok", ui_locale_fallback=None) == "en"


def test_invalid_ui_locale_falls_through_to_default():
    assert detect_reply_locale("hi", ui_locale_fallback="fr") == "en"


def test_custom_min_chars_lets_short_text_through():
    msg = "What is quicksort?"  # 18 chars
    assert detect_reply_locale(msg, ui_locale_fallback="zh") == "zh"
    assert detect_reply_locale(msg, ui_locale_fallback="zh", min_chars=10) == "en"


# ── reply_language_directive ───────────────────────────────────────────


def test_directive_for_zh_mentions_chinese_and_recency():
    out = reply_language_directive("zh")
    assert "[REPLY LANGUAGE]" in out
    assert "Chinese" in out
    assert "MOST RECENT" in out


def test_directive_for_en_mentions_english():
    out = reply_language_directive("en")
    assert "English" in out
    assert "Never mix two languages" in out


def test_directive_for_unknown_locale_falls_back_to_default():
    out = reply_language_directive("fr")
    assert "English" in out


def test_directive_for_none_falls_back_to_default():
    out = reply_language_directive(None)
    assert "English" in out


# ── interview_agent enforcement ────────────────────────────────────────


@pytest.mark.asyncio
async def test_enforcement_no_op_when_feedback_is_short():
    """Short noisy feedback < min chars stays untouched even on mismatch."""
    from agents.nodes.interview_agent import _enforce_reply_locale

    feedback = {
        "you_said": "hi",
        "interviewer_heard": "yes",
        "suggested_rephrase": "no",
        "stuck_replay": None,
    }
    user_answer = "请帮我分析一下这个回答的问题在哪里，越详细越好"
    out = await _enforce_reply_locale(feedback, user_answer=user_answer, ui_locale="zh")
    assert out["interviewer_heard"] == "yes"
    assert out["suggested_rephrase"] == "no"


@pytest.mark.asyncio
async def test_enforcement_no_op_when_already_in_target_language():
    """The detector + min-confidence threshold keeps us from translating
    feedback that's already in the right language."""
    from agents.nodes.interview_agent import _enforce_reply_locale

    feedback = {
        "you_said": "I led the project",
        "interviewer_heard": (
            "The candidate said 'I led the project' but did not name a single "
            "concrete decision they owned. I would push on that."
        ),
        "suggested_rephrase": (
            "I owned the architectural decision between SQL and document store, "
            "choosing SQL because of audit requirements."
        ),
        "stuck_replay": None,
    }
    user_answer = (
        "I led the architecture rewrite from a NoSQL store to PostgreSQL because "
        "we needed transactional integrity for the audit log."
    )
    out = await _enforce_reply_locale(feedback, user_answer=user_answer, ui_locale="en")
    assert out == feedback
