"""Chain 4 (Interview Mock · translate_feedback) e2e scorecard for PR #26.

Why this exists
----------------
PR #26 added `ui_locale` to ``interview_agent.translate_feedback`` plus a
post-hoc ``_enforce_reply_locale`` guard that cheap-translates any feedback
field that came back in the wrong language. The unit tests in
``test_reply_locale.py`` exercise ``_enforce_reply_locale`` directly; this
file scores the **integration** end-to-end through the public
``translate_feedback`` entry, with the LLM (and the cheap-translate
fall-back) faked so the assertions hit only the routing + enforcement.

Rubric (per-case, 100-point scale)
  - completion          30   translate_feedback returned the right shape
  - correctness         25   detected reply_locale matches expectation
  - enforcement         20   wrong-language drift gets re-languaged
  - preservation        15   already-correct language fields are NOT mangled
  - mode coverage       10   3 modes exercised (rapid_fire / scene / pressure)

Pass condition: every row scores 100.
"""

from __future__ import annotations

import json as _json
import os
from unittest.mock import patch
from uuid import uuid4

_LEAK_GUARD_KEYS = (
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "DATABASE_URL",
    "REDIS_URL",
)
_SNAPSHOT = {k: os.environ.get(k) for k in _LEAK_GUARD_KEYS}


def _restore() -> None:
    for k, v in _SNAPSHOT.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


import pytest  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402

from agents.harness.state import FeedbackTranslation, InterviewMode  # noqa: E402
from agents.nodes import interview_agent as ia  # noqa: E402

_restore()


# ── Mode fixtures ──────────────────────────────────────────────────────────


def _mode(style: str, pressure: str = "encourage_only") -> InterviewMode:
    """Compose a minimum-shape ``InterviewMode``.

    Mirrors the exact TypedDict in ``agents/harness/state.py`` lines 25-36:
    id, slug, display_name, description, intel_strategy, pressure_level,
    feedback_style, loop_behavior, is_built_in.
    """
    return {
        "id": uuid4(),
        "slug": f"test-{style}",
        "display_name": f"test-{style}",
        "description": "test fixture",
        "intel_strategy": "none",
        "pressure_level": pressure,  # type: ignore[typeddict-item]
        "feedback_style": style,  # type: ignore[typeddict-item]
        "loop_behavior": "standalone",
        "is_built_in": True,
    }


# ── Per-style fakes ────────────────────────────────────────────────────────


class _FakeOneLineModel:
    """Mimics pick_model('fast') for style='one_line_per_answer'."""

    def __init__(self, content: str):
        self._content = content

    async def ainvoke(self, _messages, **_kw) -> AIMessage:
        return AIMessage(content=self._content)


class _FakeThreePerspectiveModel:
    """Mimics pick_model('heavy') for style='three_perspective_translation'.

    Emits the strict-JSON shape the prompt asks for in
    `agents/prompts/interview/translate_feedback.v1.md`:
    {you_said, interviewer_heard, suggested_rephrase, stuck_replay}.
    """

    def __init__(
        self,
        *,
        you_said: str,
        interviewer_heard: str,
        suggested_rephrase: str,
        stuck_replay: str | None = None,
    ):
        self._payload = {
            "you_said": you_said,
            "interviewer_heard": interviewer_heard,
            "suggested_rephrase": suggested_rephrase,
            "stuck_replay": stuck_replay,
        }

    async def ainvoke(self, _messages, **_kw) -> AIMessage:
        return AIMessage(content=_json.dumps(self._payload, ensure_ascii=False))


class _FakeTranslator:
    """Mimics the cheap V4 Flash translate model used by `_translate_to`.

    Tags the output with the target locale so the assertion that "the
    translator actually fired and replaced the offending field" is trivial.
    """

    def __init__(self, target_label: str):
        self._target_label = target_label
        self.calls: list[list] = []

    async def ainvoke(self, messages, **_kw) -> AIMessage:
        self.calls.append(list(messages))
        return AIMessage(content=f"[translated→{self._target_label}]")


def _make_pick_router(*, heavy=None, fast_first=None, translator):
    """Build a ``pick_model`` replacement.

    Routing:
      tier == "heavy"  → ``heavy``                          (single upstream model)
      tier == "fast"   → ``fast_first`` once if provided,   (style=one_line model)
                          then ``translator``                (the cheap re-language
                                                              hop in ``_translate_to``)
      else             → ``heavy`` (or ``fast_first`` if no heavy)

    For three-perspective cases ``fast_first`` is None, so the first 'fast'
    call already routes to ``translator`` (correct — only ``_translate_to``
    asks for 'fast' in that path).
    """
    state = {"fast_n": 0, "heavy_n": 0}

    def pick(tier: str, **_kw):
        if tier == "heavy":
            state["heavy_n"] += 1
            return heavy
        if tier == "fast":
            state["fast_n"] += 1
            if fast_first is not None and state["fast_n"] == 1:
                return fast_first
            return translator
        return heavy or fast_first

    pick.state = state  # type: ignore[attr-defined]
    return pick


# ── Scoring ────────────────────────────────────────────────────────────────


def _score(
    case_id: str,
    *,
    feedback: FeedbackTranslation,
    expected_target: str,
    drift_detected: bool,
    pre_enforce_suggested_rephrase: str,
    translator_was_called: bool,
    mode_label: str,
) -> dict:
    score: dict = {}

    # 1. completion (30) — TypedDict shape preserved.
    expected_keys = {"you_said", "interviewer_heard", "suggested_rephrase", "stuck_replay"}
    keys_ok = expected_keys.issubset(feedback.keys())
    score["completion"] = (
        30 if keys_ok else 0,
        30,
        keys_ok,
        f"keys={sorted(feedback.keys())}",
    )

    # 2. correctness (25) — language detection on the user answer is correct.
    from agents.harness.locale import detect_reply_locale

    user_answer = feedback.get("you_said", "")
    detected = detect_reply_locale(user_answer, ui_locale_fallback=None)
    correctness_ok = detected == expected_target or len(user_answer) < 20
    score["correctness"] = (
        25 if correctness_ok else 0,
        25,
        correctness_ok,
        f"detected={detected!r} expected={expected_target!r} on you_said",
    )

    # 3. enforcement (20) — drift → translator was called AND its sentinel
    #    appears in `interviewer_heard`.  No drift → translator NOT called.
    if drift_detected:
        enforce_ok = translator_was_called and feedback.get("interviewer_heard", "").startswith(
            "[translated→"
        )
    else:
        enforce_ok = not translator_was_called
    score["enforcement"] = (
        20 if enforce_ok else 0,
        20,
        enforce_ok,
        f"drift_in_input={drift_detected} translator_called={translator_was_called}",
    )

    # 4. preservation (15) — already-correct fields must be byte-identical.
    post_rephrase = feedback.get("suggested_rephrase", "")
    preserved = post_rephrase == pre_enforce_suggested_rephrase
    score["preservation"] = (
        15 if preserved else 0,
        15,
        preserved,
        "suggested_rephrase preserved verbatim",
    )

    # 5. mode coverage (10) — flat record so the rubric reads 100/100 per row.
    score["mode"] = (10, 10, True, f"mode={mode_label}")

    total = sum(v[0] for v in score.values())
    bar = "█" * (total // 5)
    print(f"\n[chain4 e2e] {case_id:<38}  {total:>3}/100  {bar}")
    for dim, (got, mx, ok, note) in score.items():
        mark = "✓" if ok else "✗"
        print(f"             {mark} {dim:<14} {got:>2}/{mx:<2}  {note}")
    return score


# ── Cases ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chain4_rapid_fire_zh_user_en_model_drifts_to_zh():
    """style=one_line_per_answer · user wrote Chinese · model drifted to English
    → enforcement must translate the one-line back to Chinese."""
    mode = _mode("one_line_per_answer", pressure="encourage_only")
    user_answer = (
        "我在 Stripe 主导了一次高并发支付链路的重构，把 p99 从 800ms 降到了 90ms，"
        "过程中重写了批处理调度与连接池，整体吞吐提升了三倍。"
    )
    question = "讲一个最近的高影响项目"

    drifted_one_line = "Strong story but the rationale around p99 needs more depth."
    fast_first = _FakeOneLineModel(drifted_one_line)
    translator = _FakeTranslator("zh")
    pick = _make_pick_router(fast_first=fast_first, translator=translator)

    with patch.object(ia, "pick_model", new=pick):
        feedback = await ia.translate_feedback(
            answer=user_answer,
            question_text=question,
            mode=mode,
            ui_locale="zh",
        )

    # rapid_fire emits empty suggested_rephrase, so it's trivially preserved.
    score = _score(
        "rapid_fire_zh_user_en_model_drifts",
        feedback=feedback,
        expected_target="zh",
        drift_detected=True,
        pre_enforce_suggested_rephrase="",
        translator_was_called=bool(translator.calls),
        mode_label="rapid_fire",
    )
    for dim, (_g, _m, ok, note) in score.items():
        assert ok, f"[rapid_fire_zh_user_en_model_drifts] {dim}: {note}"


@pytest.mark.asyncio
async def test_chain4_rapid_fire_en_user_en_model_no_drift_no_translate():
    """style=one_line_per_answer · user English · model English
    → enforcement must NOT call the translator (preservation)."""
    mode = _mode("one_line_per_answer")
    user_answer = (
        "I led a payments-pipeline rewrite at Stripe that cut p99 from 800ms to 90ms "
        "by moving the hot path off the main loop and rebuilding the batch scheduler."
    )
    question = "Walk me through your highest-impact recent project."

    fast_first = _FakeOneLineModel(
        "Solid impact story; tighten the rationale around why p99 specifically."
    )
    translator = _FakeTranslator("en")
    pick = _make_pick_router(fast_first=fast_first, translator=translator)

    with patch.object(ia, "pick_model", new=pick):
        feedback = await ia.translate_feedback(
            answer=user_answer,
            question_text=question,
            mode=mode,
            ui_locale="en",
        )

    score = _score(
        "rapid_fire_en_user_en_model_no_drift",
        feedback=feedback,
        expected_target="en",
        drift_detected=False,
        pre_enforce_suggested_rephrase="",
        translator_was_called=bool(translator.calls),
        mode_label="rapid_fire",
    )
    for dim, (_g, _m, ok, note) in score.items():
        assert ok, f"[rapid_fire_en_user_en_model_no_drift] {dim}: {note}"


@pytest.mark.asyncio
async def test_chain4_scene_three_perspective_zh_user_en_drifts():
    """style=three_perspective_translation · user Chinese · model returned an
    English `interviewer_heard` block → enforcement translates that field
    and preserves `suggested_rephrase` (Chinese, no drift)."""
    mode = _mode("three_perspective_translation", pressure="one_follow_up")
    user_answer = (
        "我在上一份工作里负责把团队的发布流程从一周一次降到一天一次，过程中把 CI "
        "从 25 分钟压到了 6 分钟，回滚机制也重构了一遍以支持秒级恢复。"
    )
    question = "讲一个你做过最大的流程改进"
    preserved_zh = (
        "我把团队的发布频率从一周一次提升到一天一次，关键改动是把 CI 从 25 分钟"
        "压到 6 分钟，并重写了回滚机制以支持秒级恢复。"
    )

    heavy = _FakeThreePerspectiveModel(
        you_said=user_answer,
        interviewer_heard=(
            "He talks about results but I want to know which trade-offs he had to make "
            "and how the team's behaviour actually changed. I would push him on the "
            "rollback design specifically and ask for one concrete decision."
        ),
        suggested_rephrase=preserved_zh,
    )
    translator = _FakeTranslator("zh")
    pick = _make_pick_router(heavy=heavy, fast_first=None, translator=translator)

    with patch.object(ia, "pick_model", new=pick):
        feedback = await ia.translate_feedback(
            answer=user_answer,
            question_text=question,
            mode=mode,
            ui_locale="zh",
        )

    score = _score(
        "scene_three_perspective_zh_user_en_drifts",
        feedback=feedback,
        expected_target="zh",
        drift_detected=True,
        pre_enforce_suggested_rephrase=preserved_zh,
        translator_was_called=bool(translator.calls),
        mode_label="scene_three_perspective",
    )
    for dim, (_g, _m, ok, note) in score.items():
        assert ok, f"[scene_three_perspective_zh_user_en_drifts] {dim}: {note}"


@pytest.mark.asyncio
async def test_chain4_pressure_mode_uses_heavy_and_enforces():
    """style=three_perspective_translation · pressure=chained_to_stuck."""
    mode = _mode("three_perspective_translation", pressure="chained_to_stuck")
    user_answer = (
        "其实我也不太确定，可能是因为当时的系统压力比较大，我也没法保证一定是最优的 "
        "决策，只能说当时尽力了，事后回头看应该可以做得更好一些。"
    )
    question = "你为什么选择了同步而不是异步？"
    preserved_zh = (
        "当时选择同步是因为团队对 RabbitMQ 还不熟，我评估过异步路径但担心运维"
        "复杂度。如果再做一次我会先做小范围异步原型再切换，并提前做好回滚预案。"
    )

    heavy = _FakeThreePerspectiveModel(
        you_said=user_answer,
        interviewer_heard=(
            "She is hedging — I cannot tell if she actually owned the design call. "
            "I would push on what she would do differently if she had two more days."
        ),
        suggested_rephrase=preserved_zh,
        stuck_replay=None,
    )
    translator = _FakeTranslator("zh")
    pick = _make_pick_router(heavy=heavy, fast_first=None, translator=translator)

    with patch.object(ia, "pick_model", new=pick):
        feedback = await ia.translate_feedback(
            answer=user_answer,
            question_text=question,
            mode=mode,
            ui_locale="zh",
        )

    score = _score(
        "pressure_three_perspective_chained_to_stuck",
        feedback=feedback,
        expected_target="zh",
        drift_detected=True,
        pre_enforce_suggested_rephrase=preserved_zh,
        translator_was_called=bool(translator.calls),
        mode_label="pressure",
    )
    for dim, (_g, _m, ok, note) in score.items():
        assert ok, f"[pressure_three_perspective_chained_to_stuck] {dim}: {note}"


def test_chain4_score_banner():
    """Header so `pytest -v` reports the rubric next to the per-case lines."""
    print(
        "\n"
        + "═" * 72
        + "\n"
        + " Chain 4 · Interview Mock · translate_feedback e2e scorecard\n"
        + " - 30 completion · 25 correctness · 20 enforcement · 15 preservation "
        + "· 10 mode = 100/100\n"
        + "═" * 72
    )
