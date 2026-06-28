"""Integration tests for /ask/stream + /ask/resume around the dock path.

Verifies:
  - Default (RELAY_DOCK_REACT off): legacy router still runs (smoke).
  - With RELAY_DOCK_REACT=1: a clear regex hit fast-paths to dispatch
    (no dock LLM call); an open-ended message falls through to dock_agent.
  - _owns_dock_thread correctly accepts/rejects thread shapes.
  - /ask/resume rejects threads the user doesn't own (403).
  - /ask/resume Pydantic validators clamp value sizes.

We mock the dock-agent factory so no real LLM is hit. SSE streams are
collected into a list of {event, …} dicts for assertion.

WHY THE ENV-RESTORE PROLOGUE: ``agents.api.server`` runs ``load_dotenv``
at module-import time which leaks the repo's ``.env`` into ``os.environ``
for the rest of the pytest process. Other tests (notably
``test_prepare_application``) assume keys like ``OPENROUTER_API_KEY`` are
unset on entry. We snapshot the env BEFORE the import and atexit-restore
it so collecting this module doesn't poison the suite.
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


# atexit runs at process teardown; pytest also re-imports our autouse fixture
# below to undo per-test leaks. Both are safe — restoring to the snapshot is
# idempotent.
atexit.register(_restore_env_snapshot)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from agents.api import server as srv  # noqa: E402
from agents.api.deps import current_user  # noqa: E402
from agents.coordinator import dock_agent  # noqa: E402

# Immediately undo the .env load that server import just performed. The
# subset we care about is the same _LEAK_GUARD_KEYS list.
_restore_env_snapshot()


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    # CRITICAL: importing agents.api.server runs load_dotenv on the repo's
    # .env at module-load time, which pollutes OPENROUTER_API_KEY for the
    # rest of the pytest process. Other tests (e.g. test_prepare_application)
    # ASSUME the key is unset in their isolated default. Snapshot + restore
    # it ourselves so importing server.py via this test module doesn't leak
    # into theirs.
    import os

    snapshot = {
        k: os.environ.get(k)
        for k in (
            "OPENROUTER_API_KEY",
            "OPENROUTER_BASE_URL",
            "DATABASE_URL",
            "REDIS_URL",
        )
    }
    yield
    for k, v in snapshot.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return


@pytest.fixture
def client():
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def _parse_sse(body: str) -> list[dict]:
    """Parse an SSE text body into a list of payload dicts."""
    out = []
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        try:
            out.append(json.loads(payload))
        except json.JSONDecodeError:
            continue
    return out


def test_owns_dock_thread_ask_vantage_ok():
    u = uuid4()
    assert srv._owns_dock_thread(thread_id=f"ask_vantage:{u}", user_id=u) is True


def test_owns_dock_thread_ask_vantage_mismatch():
    u, other = uuid4(), uuid4()
    assert srv._owns_dock_thread(thread_id=f"ask_vantage:{other}", user_id=u) is False


def test_owns_dock_thread_resume_studio_ok():
    u = uuid4()
    root = uuid4()
    assert srv._owns_dock_thread(thread_id=f"resume_studio:{u}:{root}", user_id=u) is True


def test_owns_dock_thread_build_resume_mismatch():
    u, other = uuid4(), uuid4()
    assert srv._owns_dock_thread(thread_id=f"build_resume:{other}:{uuid4()}", user_id=u) is False


def test_owns_dock_thread_rejects_mock_threads():
    u = uuid4()
    assert srv._owns_dock_thread(thread_id=f"mock:{uuid4()}", user_id=u) is False


def test_owns_dock_thread_rejects_unknown_shapes():
    u = uuid4()
    assert srv._owns_dock_thread(thread_id="bogus", user_id=u) is False
    assert srv._owns_dock_thread(thread_id="", user_id=u) is False


def test_ask_resume_403_when_thread_not_owned(client):
    tc, user_id = client
    foreign_thread = f"ask_vantage:{uuid4()}"  # not user_id
    resp = tc.post(
        "/ask/resume",
        json={"resume_token": foreign_thread, "value": "approve"},
    )
    assert resp.status_code == 403


def test_ask_resume_422_when_value_too_big(client):
    tc, user_id = client
    own_thread = f"ask_vantage:{user_id}"
    huge = "x" * 12_000
    resp = tc.post(
        "/ask/resume",
        json={"resume_token": own_thread, "value": huge},
    )
    assert resp.status_code == 422
    detail = resp.json()
    assert "10000" in json.dumps(detail), detail


def test_ask_resume_422_when_dict_too_big(client):
    tc, user_id = client
    own_thread = f"ask_vantage:{user_id}"
    big_dict = {"k" + str(i): "x" * 200 for i in range(150)}
    resp = tc.post(
        "/ask/resume",
        json={"resume_token": own_thread, "value": big_dict},
    )
    assert resp.status_code == 422


def _make_dock_event(kind, payload):
    return dock_agent.DockEvent(kind=kind, payload=payload)


def test_ask_stream_legacy_path_runs(client, monkeypatch):
    """Default (no RELAY_DOCK_REACT): /ask/stream falls through legacy router."""
    monkeypatch.delenv("RELAY_DOCK_REACT", raising=False)
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", False)
    tc, _ = client

    async def fake_classify(_msg):
        from agents.coordinator.router import Intent

        return Intent(intent="other", confidence=0.5, args={}, via="regex")

    async def fake_dispatch(*args, **kwargs):
        return {"agent": "coordinator", "action": "reply", "text": "hi"}

    with (
        patch("agents.api.server.classify_intent", new=fake_classify),
        patch("agents.api.server.dispatch", new=fake_dispatch),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "hello"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    kinds = [e.get("event") for e in events]
    assert "thinking" in kinds
    assert "intent" in kinds
    assert "result" in kinds
    assert kinds[-1] == "done"


def test_ask_stream_dock_branch_runs(client, monkeypatch):
    """RELAY_DOCK_REACT=1: open-ended message goes through dock_agent + emits
    task_graph + delta + result + done."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    plan = {"status": "ok", "plan_id": "p-1", "user_goal": "hi", "plan": []}

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("plan", {"plan": plan})
        yield _make_dock_event("tool_start", {"tool": "list_my_applications", "args": {}})
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "list_my_applications",
                "result": {"status": "ok", "items": [], "count": 0},
            },
        )
        yield _make_dock_event("assistant_delta", {"text": "Got it."})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post(
            "/ask/stream",
            json={"message": "what's happening in my pipeline?"},
        )
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    types = [e.get("event") for e in events]
    assert "intent" not in types
    assert "task_graph" in types
    assert "delta" in types
    assert "result" in types
    assert "done" in types
    tg = next(e for e in events if e.get("event") == "task_graph")
    assert tg["graph"]["plan_id"] == "p-1"
    res = next(e for e in events if e.get("event") == "result")
    assert res["agent"] == "applications"
    assert res["action"] == "list"


def test_ask_stream_dock_emits_tool_trace_on_tool_end(client, monkeypatch):
    """Step 3 — tool_end MUST fan out into tool_trace + result frames.

    The tool_trace event carries the short summary the dock console row
    renders; the result event keeps the existing artifact pipeline.
    """
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "list_my_applications",
                "result": {"status": "ok", "items": [], "count": 0},
            },
        )
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "list my apps"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    traces = [e for e in events if e.get("event") == "tool_trace"]
    assert len(traces) == 1
    t = traces[0]
    assert t["tool"] == "list_my_applications"
    assert t["agent"] == "applications"
    assert t["action"] == "list"
    assert t["status"] == "ok"
    assert "0 item" in t["summary"]
    # Trace MUST come before the matching result so the dock can render
    # the console row above the artifact card.
    types = [e.get("event") for e in events]
    assert types.index("tool_trace") < types.index("result")


def test_ask_stream_dock_tool_trace_hides_system_tools(client, monkeypatch):
    """propose_plan / narrate / recall_* must NOT show up in the console."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        # recall returning data — should NOT produce a tool_trace
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "recall_user_memory",
                "result": {"status": "ok", "items": [{"x": 1}]},
            },
        )
        # Visible tool — SHOULD produce a tool_trace
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "list_my_applications",
                "result": {"status": "ok", "items": [], "count": 0},
            },
        )
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "list my apps"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    traces = [e for e in events if e.get("event") == "tool_trace"]
    assert len(traces) == 1
    assert traces[0]["tool"] == "list_my_applications"


def test_ask_stream_dock_tool_trace_on_error(client, monkeypatch):
    """tool_error MUST also emit a tool_trace, with status=error."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    # P3-1: force the dock branch even for high-confidence regex hits —
    # this test specifically covers the dock pipeline's tool_error trace.
    monkeypatch.setattr(srv, "_DOCK_REGEX_FAST_PATH_THRESHOLD", 0.99)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("tool_error", {"tool": "find_jobs", "error": "OpenRouter timeout"})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "find jobs"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    traces = [e for e in events if e.get("event") == "tool_trace"]
    assert len(traces) == 1
    assert traces[0]["status"] == "error"
    assert traces[0]["tool"] == "find_jobs"
    # And the error frame still rides through afterward.
    assert any(e.get("event") == "error" for e in events)


def test_ask_stream_dock_emits_narrator_frame(client, monkeypatch):
    """Step 1 — DockEvent(kind='narrator') must surface as event: narrator."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("narrator", {"text": "Looking up your last Stripe applications."})
        yield _make_dock_event("tool_start", {"tool": "list_my_applications", "args": {}})
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "list_my_applications",
                "result": {"status": "ok", "items": [], "count": 0},
            },
        )
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post(
            "/ask/stream",
            json={"message": "what about Stripe lately?"},
        )
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    narrators = [e for e in events if e.get("event") == "narrator"]
    assert len(narrators) == 1
    assert narrators[0]["text"] == "Looking up your last Stripe applications."
    # Narrator must come BEFORE the execution tool's "thinking" spinner.
    # gen() emits a leading "thinking: coordinator" envelope first, so we
    # compare against the *applications* spinner specifically.
    narrator_idx = next(i for i, e in enumerate(events) if e.get("event") == "narrator")
    exec_thinking_idx = next(
        i
        for i, e in enumerate(events)
        if e.get("event") == "thinking" and e.get("agent") == "applications"
    )
    assert narrator_idx < exec_thinking_idx


def test_ask_stream_dock_empty_narrator_dropped(client, monkeypatch):
    """An empty narration must not produce a wire frame."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("narrator", {"text": ""})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "anything"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    assert not any(e.get("event") == "narrator" for e in events)


def test_ask_stream_dock_fast_path_skips_react(client, monkeypatch):
    """High-confidence regex (e.g. 'list my applications') must bypass the
    dock loop and go straight to dispatch — saves the main-loop LLM tax."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    monkeypatch.setattr(srv, "_DOCK_REGEX_FAST_PATH_THRESHOLD", 0.9)
    tc, _ = client

    async def fake_dispatch(*args, **kwargs):
        return {"agent": "applications", "action": "list", "count": 0, "items": []}

    dock_called = {"n": 0}

    async def fake_run_dock_turn(**_kw):
        dock_called["n"] += 1
        if False:  # pragma: no cover
            yield None

    with (
        patch("agents.api.server.dispatch", new=fake_dispatch),
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "list my applications please"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    types = [e.get("event") for e in events]
    assert "intent" in types
    assert "result" in types
    assert "task_graph" not in types
    assert dock_called["n"] == 0
    intent_evt = next(e for e in events if e.get("event") == "intent")
    assert intent_evt["via"] == "regex_fast_path"


def test_ask_stream_dock_branch_handles_tool_error(client, monkeypatch):
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    # P3-1: keep this test in the dock branch even after fast-path lowered.
    monkeypatch.setattr(srv, "_DOCK_REGEX_FAST_PATH_THRESHOLD", 0.99)
    tc, _ = client

    async def fake_run_dock_turn(**_kw):
        yield _make_dock_event("tool_start", {"tool": "find_jobs", "args": {}})
        yield _make_dock_event("tool_error", {"tool": "find_jobs", "error": "timeout"})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "find me roles"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    types = [e.get("event") for e in events]
    assert "error" in types
    err = next(e for e in events if e.get("event") == "error")
    assert err["code"] == "tool_failed"
    assert err["detail"].startswith("timeout")


# ───────────────────────────────────────────────────────────────────────
# Step 3 — _tool_result_summary heuristic
# ───────────────────────────────────────────────────────────────────────


def test_tool_result_summary_explicit_summary_wins():
    """An explicit ``summary`` field on the result takes precedence."""
    assert (
        srv._tool_result_summary({"status": "ok", "summary": "Pulled 5 matches."})
        == "Pulled 5 matches."
    )


def test_tool_result_summary_uses_count():
    out = srv._tool_result_summary({"status": "ok", "count": 3})
    assert out == "ok · 3 items"


def test_tool_result_summary_count_singular():
    out = srv._tool_result_summary({"status": "ok", "count": 1})
    assert out == "ok · 1 item"


def test_tool_result_summary_uses_items_length_when_no_count():
    out = srv._tool_result_summary({"status": "ok", "items": [1, 2]})
    assert out == "ok · 2 items"


def test_tool_result_summary_needs_args_envelope():
    out = srv._tool_result_summary({"status": "needs_args", "agent": "resume_agent"})
    assert out == "needs_args · resume_agent"


def test_tool_result_summary_fallback_to_status():
    assert srv._tool_result_summary({"status": "ok"}) == "ok"
    # Missing status falls back to "ok".
    assert srv._tool_result_summary({}) == "ok"


def test_tool_result_summary_caps_at_160_chars():
    long = "x" * 500
    assert len(srv._tool_result_summary({"status": "ok", "summary": long})) == 160


def test_tool_result_summary_none_returns_ok():
    """Tools that return a string (not a dict) get a default summary."""
    assert srv._tool_result_summary(None) == "ok"


# ───────────────────────────────────────────────────────────────────────
# Step 4 — _PlanProgress + plan_step plumbing
# ───────────────────────────────────────────────────────────────────────


def test_plan_progress_assigns_steps_in_order():
    p = srv._PlanProgress()
    p.set_plan(
        {
            "plan": [
                {"step": "fetch", "agent": "jobmatch_agent"},
                {"step": "tailor", "agent": "resume_agent", "requires_review": True},
            ]
        }
    )
    assert p.assign_for_start("find_jobs", "jobmatch_agent") == "fetch"
    assert p.pop_for_end("find_jobs") == "fetch"
    assert p.assign_for_start("tailor_resume", "resume_agent") == "tailor"
    assert p.pop_for_end("tailor_resume") == "tailor"


def test_plan_progress_handles_same_agent_twice():
    """A plan with the same agent in two steps must light up each row once."""
    p = srv._PlanProgress()
    p.set_plan(
        {
            "plan": [
                {"step": "first_pass", "agent": "resume_agent"},
                {"step": "second_pass", "agent": "resume_agent"},
            ]
        }
    )
    assert p.assign_for_start("tailor_resume", "resume_agent") == "first_pass"
    assert p.pop_for_end("tailor_resume") == "first_pass"
    assert p.assign_for_start("tailor_resume", "resume_agent") == "second_pass"
    assert p.pop_for_end("tailor_resume") == "second_pass"


def test_plan_progress_no_match_returns_none():
    """Off-plan tool calls produce no plan_step."""
    p = srv._PlanProgress()
    p.set_plan({"plan": [{"step": "x", "agent": "resume_agent"}]})
    # Different agent — no match.
    assert p.assign_for_start("find_jobs", "jobmatch_agent") is None


def test_plan_progress_empty_plan_is_safe():
    p = srv._PlanProgress()
    p.set_plan({})
    assert p.assign_for_start("any", "any") is None
    p.set_plan({"plan": "not-a-list"})  # type: ignore[arg-type]
    assert p.assign_for_start("any", "any") is None


def test_ask_stream_dock_tags_frames_with_plan_step(client, monkeypatch):
    """End-to-end: plan → tool_start → tool_end must carry plan_step."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event(
            "plan",
            {
                "plan": {
                    "plan": [
                        {
                            "step": "fetch_apps",
                            "agent": "applications",
                            "requires_review": False,
                        }
                    ]
                }
            },
        )
        yield _make_dock_event("tool_start", {"tool": "list_my_applications", "args": {}})
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "list_my_applications",
                "result": {"status": "ok", "items": [], "count": 0},
            },
        )
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "list my apps"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)

    # The applications "thinking" event must carry the plan_step.
    apps_thinking = next(
        e for e in events if e.get("event") == "thinking" and e.get("agent") == "applications"
    )
    assert apps_thinking["plan_step"] == "fetch_apps"

    # And the tool_trace + result frames as well.
    trace = next(e for e in events if e.get("event") == "tool_trace")
    assert trace["plan_step"] == "fetch_apps"

    result = next(e for e in events if e.get("event") == "result")
    assert result["plan_step"] == "fetch_apps"


def test_ask_stream_dock_forwards_partial_artifact(client, monkeypatch):
    """Step 5 — a partial_artifact DockEvent must surface as event: partial_artifact."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        # Three live snapshots followed by the final tool_end.
        for i in (1, 2, 3):
            yield _make_dock_event(
                "partial_artifact",
                {
                    "artifact_id": "tailor-1",
                    "kind": "resume_bullet",
                    "title": "Tailored résumé draft",
                    "sub": f"Bullet {i} of 3",
                    "progress": i / 3,
                    "payload": {"items": [f"Bullet {j}" for j in range(1, i + 1)]},
                },
            )
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "tailor_resume",
                "result": {"status": "ok", "summary": "done"},
            },
        )
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "tailor it"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    partials = [e for e in events if e.get("event") == "partial_artifact"]
    assert len(partials) == 3
    assert partials[0]["artifact_id"] == "tailor-1"
    assert partials[0]["sub"] == "Bullet 1 of 3"
    assert partials[2]["progress"] == 1.0
    # All partials must precede the final result frame.
    res_idx = next(i for i, e in enumerate(events) if e.get("event") == "result")
    for i, e in enumerate(events):
        if e.get("event") == "partial_artifact":
            assert i < res_idx


def test_ask_stream_dock_partial_without_artifact_id_dropped(client, monkeypatch):
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("partial_artifact", {"kind": "resume_bullet", "progress": 0.5})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "tailor"})
    events = _parse_sse(resp.text)
    assert not any(e.get("event") == "partial_artifact" for e in events)


def test_ask_stream_dock_no_plan_omits_plan_step(client, monkeypatch):
    """When there's no plan, plan_step must NOT appear on any frame."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("tool_start", {"tool": "list_my_applications", "args": {}})
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "list_my_applications",
                "result": {"status": "ok", "items": [], "count": 0},
            },
        )
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "list my apps"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    for ev in events:
        assert "plan_step" not in ev, f"unexpected plan_step on {ev}"


# ─── Inline-detail upgrade SSE protocol tests ──────────────────────────


def test_ask_stream_dock_forwards_reasoning_event(client, monkeypatch):
    """reasoning_delta DockEvent must surface as `event: reasoning` on the wire."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("reasoning_delta", {"text": "let me check…"})
        yield _make_dock_event("reasoning_delta", {"text": " and weigh options."})
        yield _make_dock_event("assistant_delta", {"text": "Sure thing."})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "anything"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    reasoning_frames = [e for e in events if e.get("event") == "reasoning"]
    assert [r["text"] for r in reasoning_frames] == [
        "let me check…",
        " and weigh options.",
    ]


def test_ask_stream_dock_empty_reasoning_is_dropped(client, monkeypatch):
    """An empty reasoning payload must not produce a wire frame."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("reasoning_delta", {"text": ""})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "anything"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    assert not any(e.get("event") == "reasoning" for e in events)


def test_ask_stream_dock_tool_start_carries_tool_and_args(client, monkeypatch):
    """The `thinking` frame for a visible tool must carry tool + args inline."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event(
            "tool_start",
            {"tool": "list_my_applications", "args": {"status": "open"}},
        )
        yield _make_dock_event(
            "tool_end",
            {
                "tool": "list_my_applications",
                "result": {"status": "ok", "items": [], "count": 0},
            },
        )
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "list my apps"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    thinking = [e for e in events if e.get("event") == "thinking"]
    assert any(
        t.get("tool") == "list_my_applications" and t.get("args") == {"status": "open"}
        for t in thinking
    )


def test_ask_stream_dock_tool_trace_includes_result(client, monkeypatch):
    """The tool_trace frame must surface the (capped) result for the dock console."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    result_body = {"status": "ok", "items": [{"id": "j1"}], "count": 1}

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[dock_agent.DockEvent]:
        yield _make_dock_event("tool_end", {"tool": "list_my_applications", "result": result_body})
        yield _make_dock_event("done", {})

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "list my apps"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    traces = [e for e in events if e.get("event") == "tool_trace"]
    assert len(traces) == 1
    assert traces[0]["result"] == result_body


# ─────────────────────────────────────────────────────────────────────
# P0-2 IDOR guard on /ask/stream X-Relay-Thread-Id
# ─────────────────────────────────────────────────────────────────────


def test_ask_stream_rejects_foreign_thread_id(client):
    """Header pointing at another user's thread must yield 403."""
    tc, _ = client
    foreign_thread = f"ask_vantage:{uuid4()}"  # not the auth'd user's id
    resp = tc.post(
        "/ask/stream",
        json={"message": "hi"},
        headers={"X-Relay-Thread-Id": foreign_thread},
    )
    assert resp.status_code == 403
    body = resp.json()
    # Envelope v2 (docs/architecture/error-handling.md §2.1) nests every
    # error field under `error`. We accept the legacy top-level shape as
    # a fallback only for the brief migration window.
    err = body.get("error") or body
    msg = err.get("message", "") if isinstance(err, dict) else ""
    assert "not yours" in msg, body


def test_ask_stream_rejects_unknown_thread_shape(client):
    """A thread id of unknown shape must also be rejected (defense in depth)."""
    tc, _ = client
    resp = tc.post(
        "/ask/stream",
        json={"message": "hi"},
        headers={"X-Relay-Thread-Id": "bogus-not-a-thread"},
    )
    assert resp.status_code == 403


def test_ask_stream_accepts_own_thread_id(client, monkeypatch):
    """Header with the user's own thread id continues to work."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", False)
    tc, user_id = client
    own_thread = f"ask_vantage:{user_id}"

    async def fake_classify(_msg):
        from agents.coordinator.router import Intent

        return Intent(intent="other", confidence=0.5, args={}, via="regex")

    async def fake_dispatch(*args, **kwargs):
        return {"agent": "coordinator", "action": "reply", "text": "hi"}

    with (
        patch("agents.api.server.classify_intent", new=fake_classify),
        patch("agents.api.server.dispatch", new=fake_dispatch),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post(
            "/ask/stream",
            json={"message": "hello"},
            headers={"X-Relay-Thread-Id": own_thread},
        )
    assert resp.status_code == 200


def test_ask_stream_no_header_still_works(client, monkeypatch):
    """Missing X-Relay-Thread-Id falls back to ask_vantage_thread_id(user)."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", False)
    tc, _ = client

    async def fake_classify(_msg):
        from agents.coordinator.router import Intent

        return Intent(intent="other", confidence=0.5, args={}, via="regex")

    async def fake_dispatch(*args, **kwargs):
        return {"agent": "coordinator", "action": "reply", "text": "hi"}

    with (
        patch("agents.api.server.classify_intent", new=fake_classify),
        patch("agents.api.server.dispatch", new=fake_dispatch),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "hello"})
    assert resp.status_code == 200
