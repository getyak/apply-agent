"""End-to-end test for /ask/stream dock branch — REAL graph, fake LLM.

Regression we are locking down (traceId 68f6d78f / ed4f208e, 2026-06-28):
the dock's ``graph.astream_events(...)`` path crashed with
``NotImplementedError`` at ``aget_tuple``. Root cause: the checkpointer
factory returned the **sync** ``PostgresSaver``, which lacks the async API
LangGraph streaming requires.

PR2 cutover: the dock now streams native AG-UI frames (RUN_STARTED …
RUN_FINISHED) instead of the old ``event: thinking/intent/result/done``
vocabulary. This file exercises the REAL graph build + the REAL adapter
plumbing, swapping ONLY the model boundary (``harness.llm.pick_model``) for a
FakeMessagesListChatModel.

Invariants:
  1. ``hi`` → /ask/stream → AG-UI stream contains RUN_STARTED + RUN_FINISHED
     and no RUN_ERROR frame.
  2. No ``dock_turn_failed`` log line is emitted.
  3. The path works for both the lifetime ``ask_vantage:`` thread AND the
     scoped ``resume_studio:`` thread (the surface that triggered the original
     report).
  4. Whatever ``get_checkpointer()`` returns implements BOTH the sync and the
     async checkpoint API (``aget_tuple`` / ``aput`` / ``alist``).
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
    """

    def bind_tools(self, tools, **_kwargs):  # type: ignore[override]
        return self


@pytest.fixture
def fake_model(monkeypatch):
    """Replace harness.llm.pick_model with a deterministic chat model."""
    fake = _ToolBindableFakeChat(responses=[AIMessage(content="Hi! I'm Vantage. How can I help?")])

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
    """Parse the SSE body into a list of decoded JSON event dicts.

    AG-UI frames are ``data: {...}\\n\\n``; heartbeat frames are
    ``event: heartbeat\\ndata: {}\\n\\n``. We only decode the data lines.
    """
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


def _has_no_run_error(events: list[dict]) -> None:
    """Assert there's no AG-UI RUN_ERROR frame — the original bug emitted one."""
    errs = [e for e in events if e.get("type") == "RUN_ERROR"]
    assert errs == [], f"unexpected RUN_ERROR frames: {errs}"


def test_dock_streams_hi_through_real_graph(client, fake_model, monkeypatch, caplog):
    """``hi`` → real build_dock_graph + AG-UI adapter → RUN_FINISHED, no error.

    This was the failing case at traceId 68f6d78f. Locks down:
      - the adapter runs without raising NotImplementedError
      - checkpointer.get_checkpointer() returns a saver whose async API works
      - the dock emits a normal RUN_FINISHED frame instead of RUN_ERROR
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

    _has_no_run_error(events)
    types = [e.get("type") for e in events]
    assert "RUN_STARTED" in types, f"missing RUN_STARTED, got {types}"
    assert "RUN_FINISHED" in types, f"missing RUN_FINISHED, got {types}"

    # The legacy router path emits ``event: intent`` SSE frames; the dock
    # branch never does. If _DOCK_REACT_ENABLED slipped off we'd see one.
    assert not any(e.get("event") == "intent" for e in events), (
        f"dock branch wrongly fell through to legacy router: {types}"
    )

    failures = [r for r in caplog.records if "dock_turn_failed" in r.getMessage()]
    assert failures == [], f"dock_turn_failed was logged: {[r.getMessage() for r in failures]}"


def test_dock_streams_hi_on_resume_studio_thread(client, fake_model, monkeypatch, caplog):
    """Same as above, but for the scoped resume_studio thread."""
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

    _has_no_run_error(events)
    types = [e.get("type") for e in events]
    assert "RUN_FINISHED" in types, f"missing RUN_FINISHED, got {types}"

    failures = [r for r in caplog.records if "dock_turn_failed" in r.getMessage()]
    assert failures == [], f"dock_turn_failed was logged: {[r.getMessage() for r in failures]}"


def test_dock_stream_frames_carry_relay_envelope(client, fake_model, monkeypatch):
    """Every AG-UI frame on the wire carries the Relay envelope in rawEvent."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, user_id = client

    resp = tc.post("/ask/stream", json={"message": "hi"}, headers={"X-Relay-Surface": "dock"})
    assert resp.status_code == 200, resp.text
    events = _parse_sse(resp.text)
    agui = [e for e in events if "type" in e]
    assert agui, "no AG-UI frames found"
    for e in agui:
        raw = e.get("rawEvent") or {}
        assert raw.get("run_id"), e
        assert raw.get("protocol_version"), e
        assert isinstance(raw.get("seq"), int), e


def test_checkpointer_singleton_supports_async_api():
    """Whatever ``get_checkpointer()`` returns MUST have both sync and async
    APIs callable — the bug was that ``aget_tuple`` raised NotImplementedError.
    """
    saver = cp.get_checkpointer()
    for attr in ("get_tuple", "put", "list"):
        assert callable(getattr(saver, attr, None)), f"missing sync {attr}"
    for attr in ("aget_tuple", "aput", "alist"):
        assert callable(getattr(saver, attr, None)), f"missing async {attr}"
