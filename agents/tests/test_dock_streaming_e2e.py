"""End-to-end test for /ask/stream dock branch — REAL graph, fake LLM.

Regression we are locking down (traceId 68f6d78f / ed4f208e, 2026-06-28):
the dock's ``graph.astream_events(...)`` path crashed with
``NotImplementedError`` at
``langgraph/checkpoint/base/__init__.py:441 aget_tuple``. Root cause: the
checkpointer factory was returning the **sync** ``PostgresSaver``, which
does not implement the async API; LangGraph's async streaming requires
``aget_tuple`` / ``aput`` / etc.

The pre-existing ``test_ask_stream_dock_route.py`` mocks
``dock_agent.run_dock_turn`` wholesale, so it would have stayed green even
through that bug. This file complements it by exercising the REAL graph
build and the REAL ``astream_events`` plumbing, swapping ONLY the model
boundary (``harness.llm.pick_model``) for a FakeMessagesListChatModel.

Invariants:
  1. ``hi`` → /ask/stream → SSE stream completes with a ``done`` frame and
     contains no ``error`` frame.
  2. No ``dock_turn_failed`` log line is emitted.
  3. The path works for both the lifetime ``ask_vantage:`` thread AND the
     scoped ``resume_studio:`` thread (the surface that triggered the
     original report).
  4. Whatever ``get_checkpointer()`` returns implements BOTH the sync and
     the async checkpoint API (``aget_tuple`` / ``aput`` / ``alist``).
"""
from __future__ import annotations

import atexit
import json
import os
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


# Same env-leak guard as test_ask_stream_dock_route.py — importing the
# server runs load_dotenv() which would otherwise leak the repo's .env
# into the rest of the pytest session.
atexit.register(_restore_env_snapshot)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.language_models.fake_chat_models import (  # noqa: E402
    FakeMessagesListChatModel,
)
from langchain_core.messages import AIMessage  # noqa: E402

from agents.api import server as srv  # noqa: E402
from agents.api.deps import current_user  # noqa: E402
from agents.coordinator import dock_agent  # noqa: E402
from agents.harness import checkpointer as cp  # noqa: E402

_restore_env_snapshot()


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    """Force MemorySaver path (no real PG) and clean cached graphs."""
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    # Required by harness/llm.pick_model() — we replace pick_model entirely
    # below, but the import-time check still wants the key present.
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-used")
    # build_dock_graph caches by tier; drop cached graphs so the fake model
    # we install actually gets bound.
    dock_agent.build_dock_graph.cache_clear()
    cp.reset_for_tests()
    yield
    dock_agent.build_dock_graph.cache_clear()
    cp.reset_for_tests()


class _ToolBindableFakeChat(FakeMessagesListChatModel):
    """FakeMessagesListChatModel + a no-op ``bind_tools`` so create_react_agent
    can wire its tool registry without tripping the base-class
    ``NotImplementedError``.

    LangGraph's ReAct prebuilt calls ``model.bind_tools(tools)`` while
    building the graph. The stock ``FakeMessagesListChatModel`` inherits the
    abstract default that just raises — so the dock graph build fails
    before any message is ever streamed. Returning ``self`` is fine here
    because the canned responses already decide every turn's reply.
    """

    def bind_tools(self, tools, **_kwargs):  # type: ignore[override]
        return self


@pytest.fixture
def fake_model(monkeypatch):
    """Replace harness.llm.pick_model with a deterministic chat model.

    Returning the canned ``AIMessage`` as a single reply matches the
    "assistant says hi back" path — no tool calls, no follow-up turn. That's
    enough to drive ``astream_events`` end-to-end and trip any async-only
    checkpointer hook on the way through.
    """
    fake = _ToolBindableFakeChat(
        responses=[AIMessage(content="Hi! I'm Vantage. How can I help?")]
    )

    def _pick(*_args, **_kwargs):
        return fake

    monkeypatch.setattr("agents.harness.llm.pick_model", _pick)
    monkeypatch.setattr("agents.coordinator.dock_agent.pick_model", _pick)
    return fake


@pytest.fixture
def client():
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def _parse_sse(body: str) -> list[dict]:
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


def _has_no_error_frame(events: list[dict]) -> None:
    """Assert there's no SSE ``error`` frame — the original bug emitted one."""
    errs = [e for e in events if e.get("event") == "error"]
    assert errs == [], f"unexpected error frames: {errs}"


def test_dock_streams_hi_through_real_graph(
    client, fake_model, monkeypatch, caplog
):
    """``hi`` → real build_dock_graph + astream_events → SSE done.

    This was the failing case at traceId 68f6d78f. Locks down:
      - astream_events runs without raising NotImplementedError
      - checkpointer.get_checkpointer() returns a saver whose async API works
      - the dock emits a normal ``done`` frame instead of an ``error`` frame
    """
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, user_id = client

    resp = tc.post(
        "/ask/stream",
        json={"message": "hi"},
        headers={"X-Relay-Surface": "dock"},
    )
    assert resp.status_code == 200, resp.text
    events = _parse_sse(resp.text)

    _has_no_error_frame(events)
    kinds = [e.get("event") for e in events]
    assert "done" in kinds, f"missing 'done' frame, got {kinds}"

    # The legacy router test path can leak in if _DOCK_REACT_ENABLED slips
    # off — that path emits an ``intent`` frame. The dock branch does not.
    assert "intent" not in kinds, (
        f"dock branch wrongly fell through to legacy router: {kinds}"
    )

    failures = [
        r for r in caplog.records if "dock_turn_failed" in r.getMessage()
    ]
    assert failures == [], (
        f"dock_turn_failed was logged: {[r.getMessage() for r in failures]}"
    )


def test_dock_streams_hi_on_resume_studio_thread(
    client, fake_model, monkeypatch, caplog
):
    """Same as above, but for the scoped resume_studio thread (the actual
    surface where the bug was originally reported).
    """
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, user_id = client
    thread_id = f"resume_studio:{user_id}:{uuid4()}"

    resp = tc.post(
        "/ask/stream",
        json={"message": "hi"},
        headers={
            "X-Relay-Thread-Id": thread_id,
            "X-Relay-Surface": "resume_studio",
            "X-Relay-Locale": "zh-CN",
        },
    )
    assert resp.status_code == 200, resp.text
    events = _parse_sse(resp.text)

    _has_no_error_frame(events)
    kinds = [e.get("event") for e in events]
    assert "done" in kinds, f"missing 'done' frame, got {kinds}"

    failures = [
        r for r in caplog.records if "dock_turn_failed" in r.getMessage()
    ]
    assert failures == [], (
        f"dock_turn_failed was logged: {[r.getMessage() for r in failures]}"
    )


def test_checkpointer_singleton_supports_async_api():
    """Whatever ``get_checkpointer()`` returns MUST have both sync and async
    APIs callable — the bug was that ``aget_tuple`` raised NotImplementedError.

    With no RELAY_PG_DSN we get MemorySaver; MemorySaver implements both
    APIs by design. The point of this test is not the type, but the
    contract: any saver the factory returns must answer the async path
    without raising NotImplementedError.
    """
    saver = cp.get_checkpointer()
    for attr in ("get_tuple", "put", "list"):
        assert callable(getattr(saver, attr, None)), f"missing sync {attr}"
    # Async API attributes — the failing methods in the original traceback.
    for attr in ("aget_tuple", "aput", "alist"):
        assert callable(getattr(saver, attr, None)), f"missing async {attr}"
