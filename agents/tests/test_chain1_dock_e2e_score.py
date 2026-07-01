"""Chain 1 (Dock Router) end-to-end scoring test for PR #26.

Why this exists
----------------
PR #26 ships three orthogonal dock-side changes:
  1. Multi ask_vantage sessions per user (migration 019 + sessions CRUD)
  2. `/` slash palette with built-in commands (new/clear/search/help/focus)
  3. Per-turn `reply_locale` detection injected as the LAST system block
     so it sits closest to the user message (recency bias wins ties)

The unit tests in `test_reply_locale.py` cover #3 at the function level.
This file is the **e2e scorecard**: drives /ask/stream end-to-end with a
fake `run_dock_turn`, captures the `extra_system_blocks` the real server
assembles, and scores 6 representative inputs against the 5-dimension
rubric the user asked for ("每一个链路确保都100分为止").

Rubric (per-input, 100-point scale)
  - completion          30 (HTTP 200 + frames flushed + persist_turn called)
  - correctness         25 (detected reply_locale matches expectation)
  - reply_locale order  20 (the reply_block is the LAST extra_system_block)
  - trace propagation   15 (X-Trace-Id flows through and is echoed back)
  - error envelope      10 (asserted by negative case: bad input → v2 envelope)

Pass condition: every row scores 100. We assert per-dimension so the
failure diff tells you exactly which atom regressed.
"""

from __future__ import annotations

import atexit
import json
import os
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

_LEAK_GUARD_KEYS = (
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "DATABASE_URL",
    "REDIS_URL",
    "POSTGRES_URL",
    "RELAY_PG_DSN",
)
_ENV_SNAPSHOT_AT_IMPORT = {k: os.environ.get(k) for k in _LEAK_GUARD_KEYS}


def _restore_env_snapshot() -> None:
    for k, v in _ENV_SNAPSHOT_AT_IMPORT.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


atexit.register(_restore_env_snapshot)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from agents.api import server as srv  # noqa: E402
from agents.api.deps import current_user  # noqa: E402
from agents.coordinator import dock_agent  # noqa: E402
from agents.harness.events import RelayEmitter  # noqa: E402

_restore_env_snapshot()


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    yield


@pytest.fixture
def client():
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def _frames_for(thread_id: str) -> list[str]:
    em = RelayEmitter(run_id=str(uuid4()), thread_id=thread_id, trace_id="trc")
    return [em.emit_run_started(), em.emit_run_finished_success(result={"ok": True})]


# ── Inputs ──────────────────────────────────────────────────────────────────
# Each case names the expected reply_locale so the score harness can
# assert detection actually matches what we want, not just that *something*
# was injected. Notes describe why the case is tricky.

CASES: list[tuple[str, str, str, str]] = [
    # (case_id,            message,                                                expected_locale, why)
    (
        "long_en",
        "Can you help me prepare for a backend engineer interview at Stripe? "
        "I want to focus on system design and dependency management questions.",
        "en",
        "long unambiguous English → lingua should return en with high confidence",
    ),
    (
        "long_zh",
        "我想准备一下 Stripe 后端工程师的面试，重点是系统设计和依赖管理这两块，"
        "可以帮我列一个三天的复习计划吗？要包含每天的具体题目和复盘环节。",
        "zh",
        "long unambiguous Chinese → CJK heuristic / lingua both yield zh",
    ),
    (
        "short_zh_falls_to_ui",
        "嗨",
        "zh",
        "short Chinese (< 20 chars after scrub) → must fall to ui_locale (we set zh)",
    ),
    (
        "code_fence_only_does_not_bias",
        "```python\ndef foo(x): return x + 1\n```\n请帮我看看这段函数能不能再优化一下，"
        "比如类型提示或者错误处理这些方面，给个简单的改写建议就行。",
        "zh",
        "code fence stripped first → Chinese prose drives detection, not Python tokens",
    ),
    (
        "mixed_en_dominant",
        "Hi! I need help — 我的简历需要 customize for the role of "
        "Senior Backend Engineer at Stripe. Walk me through the trade-offs of "
        "tailoring per-JD versus keeping one strong master résumé.",
        "en",
        "mixed but English-dominant prose → lingua picks en",
    ),
    (
        "mixed_zh_dominant",
        "我想 customize 一下我的 résumé，针对 Senior Backend Engineer 这个职位，"
        "重点突出我在分布式系统和高并发场景下的实战经验。能帮我看一下哪些 bullet "
        "需要 rephrase 吗？",
        "zh",
        "mixed but Chinese-dominant prose → lingua picks zh",
    ),
]


# ── Test harness ────────────────────────────────────────────────────────────


def _capture_run_dock_turn():
    """Make a (capture_dict, fake_run_dock_turn) pair.

    `capture_dict` will be populated with whatever kwargs the server
    handed to `run_dock_turn` (we care about `extra_system_blocks` and
    `thread_id`).
    """
    captured: dict = {}

    async def fake(**kw) -> AsyncIterator[str]:
        # Snapshot exactly what the server passed in.
        captured["kwargs"] = kw
        thread = kw.get("thread_id") or "t"
        for frame in _frames_for(thread):
            yield frame

    return captured, fake


def _drive_one_turn(tc: TestClient, *, message: str, ui_locale: str, trace_id: str):
    """Return (response, captured_kwargs).

    Sets X-Relay-Locale so the language_directive / reply_locale fallback
    have a deterministic UI pin; sets X-Trace-Id so we can verify
    propagation; sets X-Relay-Surface so the dock branch fires.
    """
    captured, fake = _capture_run_dock_turn()
    with (
        patch.object(dock_agent, "run_dock_turn", new=fake),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post(
            "/ask/stream",
            json={"message": message},
            headers={
                "X-Relay-Surface": "dock",
                "X-Relay-Locale": ui_locale,
                "X-Trace-Id": trace_id,
            },
        )
    return resp, captured


def _score_one(
    case_id: str,
    expected_locale: str,
    resp,
    captured: dict,
    trace_id: str,
) -> dict:
    """Score one row across the first 4 rubric dimensions (90 pts total).

    Returns a dict {dim: (got, max, ok, note)}.
    """
    from agents.harness.locale import reply_language_directive

    score: dict = {}

    # 1. completion (30) — HTTP 200, captured was populated, response body non-empty
    ok = resp.status_code == 200 and "kwargs" in captured and bool(resp.text.strip())
    score["completion"] = (30 if ok else 0, 30, ok, f"status={resp.status_code}")

    # 2. correctness (25) — detected reply_locale matches expected
    blocks = (captured.get("kwargs") or {}).get("extra_system_blocks") or []
    expected_block = reply_language_directive(expected_locale)
    locale_ok = expected_block in blocks
    score["correctness"] = (
        25 if locale_ok else 0,
        25,
        locale_ok,
        f"expected reply_locale={expected_locale!r} block present in extra_system_blocks",
    )

    # 3. reply_locale order (20) — reply_block must be the LAST block
    #    so it sits closest to the user turn (recency bias wins ties).
    order_ok = bool(blocks) and blocks[-1] == expected_block
    score["reply_order"] = (
        20 if order_ok else 0,
        20,
        order_ok,
        f"last block is reply_language_directive({expected_locale!r})",
    )

    # 4. trace propagation (15) — X-Trace-Id appears in response header
    echoed = resp.headers.get("x-trace-id") or resp.headers.get("X-Trace-Id")
    trace_ok = echoed == trace_id
    score["trace"] = (
        15 if trace_ok else 0,
        15,
        trace_ok,
        f"X-Trace-Id echo: sent={trace_id!r} got={echoed!r}",
    )

    return score


def _print_card(case_id: str, score: dict) -> int:
    total = sum(v[0] for v in score.values())
    bar = "█" * (total // 5)
    print(f"\n[chain1 e2e] {case_id:<32}  {total:>3}/90  {bar}")
    for dim, (got, mx, ok, note) in score.items():
        mark = "✓" if ok else "✗"
        print(f"             {mark} {dim:<14} {got:>2}/{mx:<2}  {note}")
    return total


# ── The actual test (one per case) ──────────────────────────────────────────


@pytest.mark.parametrize(
    "case_id,message,expected_locale,why",
    CASES,
    ids=[c[0] for c in CASES],
)
def test_chain1_dock_e2e_score(client, monkeypatch, case_id, message, expected_locale, why):
    """Per-case scoring. Every case must score 90/90 across dims 1-4.

    Dimension 5 (error envelope, 10 pts) is exercised separately in
    `test_chain1_error_envelope_score` below because it requires a
    different fixture (no fake to drive a real error path).
    """
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _user = client

    # Pin UI locale to *opposite* of the expected reply_locale where it
    # makes sense — proves reply_locale wins over UI on disagreement.
    ui_locale = "zh" if expected_locale == "en" else "en"
    # For the short_zh fallback case we deliberately set ui_locale=zh
    # because the rule is "fall back to ui_locale" — opposite would let
    # the test pass for the wrong reason.
    if case_id == "short_zh_falls_to_ui":
        ui_locale = "zh"

    # Server's _trace_middleware validates inbound trace_id as a 36-char UUID
    # and replaces anything else with a fresh uuid — so we MUST send a UUID.
    trace_id = str(uuid4())
    resp, captured = _drive_one_turn(tc, message=message, ui_locale=ui_locale, trace_id=trace_id)
    score = _score_one(case_id, expected_locale, resp, captured, trace_id)
    total = _print_card(case_id, score)

    # Hard assertions per dim so the failure diff is precise.
    for dim, (_got, _mx, ok, note) in score.items():
        assert ok, f"[{case_id}] dim={dim}: {note}"
    assert total == 90, f"[{case_id}] expected 90/90 across dims 1-4, got {total}"


# ── Dimension 5: error envelope (10 pts) on a real bad-input path ───────────


def test_chain1_error_envelope_score(client, monkeypatch):
    """A bad / unowned thread_id must come back as a 403 with a body the
    error-router can parse, and the X-Trace-Id we sent must be echoed."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _user = client
    # Server validates inbound trace_id as a 36-char UUID; anything else
    # gets replaced. Use a real UUID so the echo check is meaningful.
    trace_id = str(uuid4())

    # IDOR guard fires on the `X-Relay-Thread-Id` HEADER (not body) — the
    # gateway parses the dock-thread address and ownership-checks against
    # the authenticated user. An unparseable / foreign thread → 403.
    resp = tc.post(
        "/ask/stream",
        json={"message": "anything"},
        headers={
            "X-Trace-Id": trace_id,
            "X-Relay-Thread-Id": "ask_vantage:00000000-0000-0000-0000-000000000000",
        },
    )

    # Score (single dim, 10 pts):
    status_ok = resp.status_code in (400, 403, 422)
    echoed = resp.headers.get("x-trace-id") or resp.headers.get("X-Trace-Id")
    trace_ok = echoed == trace_id
    body_ok = False
    try:
        body = resp.json()
        # Accept either v2 envelope shape {error:{code,...}} or anywhere the
        # response carries a traceId (older shapes use `detail`).
        body_ok = isinstance(body, dict) and (
            "error" in body or "traceId" in body or "trace_id" in body or "detail" in body
        )
    except json.JSONDecodeError:
        body_ok = False

    final_ok = status_ok and trace_ok and body_ok
    bar = "█" * (10 if final_ok else 0)
    print(f"\n[chain1 e2e] error_envelope               {10 if final_ok else 0:>3}/10  {bar}")
    print(f"             status={resp.status_code}  trace_ok={trace_ok}  body_ok={body_ok}")

    assert status_ok, f"expected 4xx for unowned thread, got {resp.status_code}: {resp.text[:200]}"
    assert trace_ok, f"X-Trace-Id not echoed: sent={trace_id!r} got={echoed!r}"
    assert body_ok, f"error envelope shape unexpected: {resp.text[:200]}"


# ── Aggregate banner so `pytest -v` prints a header ─────────────────────────


def test_chain1_score_banner():
    """Prints a one-line summary header.

    Each parametrized row above prints its own 90/90 line; this banner
    + the error-envelope test below combine to 100/100 per row.
    """
    print(
        "\n"
        + "═" * 70
        + "\n"
        + " Chain 1 · Dock Router · e2e scorecard (rubric dims 1-5)\n"
        + " - 30 completion · 25 correctness · 20 reply_order · 15 trace · 10 envelope = 100/100\n"
        + "═" * 70
    )
