"""Integration tests for /ask/stream around the dock path (AG-UI cutover).

Verifies:
  - Default (RELAY_DOCK_REACT off): legacy router still runs (smoke).
  - With RELAY_DOCK_REACT=1: an open-ended message goes through the dock and
    streams native AG-UI frames (RUN_STARTED … RUN_FINISHED); a clear regex hit
    fast-paths to dispatch (no dock loop).
  - HITL resume via ``command={"resume": ...}`` on /ask/stream forwards to the
    dock and runs to completion.
  - _owns_dock_thread correctly accepts/rejects thread shapes (IDOR guard).
  - /ask/stream rejects a foreign / unknown thread id (403).

We patch ``dock_agent.run_dock_turn`` with a fake async generator that yields
already-encoded AG-UI SSE frame strings — the server forwards them verbatim.

WHY THE ENV-RESTORE PROLOGUE: ``agents.api.server`` runs ``load_dotenv`` at
module-import time which leaks the repo's ``.env`` into ``os.environ`` for the
rest of the pytest process. We snapshot the env BEFORE the import and
atexit-restore it so collecting this module doesn't poison the suite.
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
    import os as _os

    snapshot = {
        k: _os.environ.get(k)
        for k in ("OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "DATABASE_URL", "REDIS_URL")
    }
    yield
    for k, v in snapshot.items():
        if v is None:
            _os.environ.pop(k, None)
        else:
            _os.environ[k] = v


@pytest.fixture
def client():
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def _parse_sse(body: str) -> list[dict]:
    """Parse an SSE text body into a list of payload dicts (data lines only)."""
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


def _agui_frames(*, with_tool: bool = True) -> list[str]:
    """Build a tiny canned AG-UI frame sequence the fake run_dock_turn yields."""
    em = RelayEmitter(run_id=str(uuid4()), thread_id="t", trace_id="trc")
    frames = [em.emit_run_started()]
    if with_tool:
        frames.append(
            em.emit_custom(
                "relay.agent_start",
                {"agent": "applications", "action": "list", "tool": "list_my_applications"},
                step_id="step-1",
            )
        )
        frames.append(
            em.emit_custom(
                "relay.artifact",
                {"agent": "applications", "action": "list", "result": {"status": "ok", "count": 0}},
            )
        )
    frames.append(em.emit_run_finished_success(result={"ok": True}))
    return frames


# ───────────────────────────────────────────────────────── _owns_dock_thread


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


# ───────────────────────────────────────────────────────── legacy router path


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


# ─────────────────────────────────────────────────────── dock AG-UI path


def test_ask_stream_dock_branch_streams_agui(client, monkeypatch):
    """RELAY_DOCK_REACT=1: open-ended message → native AG-UI frames forwarded
    verbatim (no legacy thinking/intent/done wrapper)."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[str]:
        for frame in _agui_frames():
            yield frame

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "what's in my pipeline?"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    types = [e.get("type") for e in events]
    assert "RUN_STARTED" in types
    assert "RUN_FINISHED" in types
    # The legacy SSE wrapper must NOT appear in the dock branch.
    assert not any(e.get("event") in ("thinking", "intent", "done") for e in events)
    customs = [e.get("name") for e in events if e.get("type") == "CUSTOM"]
    assert "relay.agent_start" in customs
    assert "relay.artifact" in customs


def test_ask_stream_dock_forwards_frames_verbatim(client, monkeypatch):
    """The server forwards exactly the frames run_dock_turn yields (pass-through)."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    canned = _agui_frames(with_tool=False)

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[str]:
        for frame in canned:
            yield frame

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "hi"})
    # Every canned frame's data line appears in the response body untouched.
    for frame in canned:
        data_line = frame.strip()
        assert data_line in resp.text


def test_ask_stream_dock_persists_assistant_text(client, monkeypatch):
    """Assistant text is reconstructed from TEXT_MESSAGE_CONTENT deltas and
    persisted via persist_turn (gateway is pure pass-through now)."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    tc, _ = client

    em = RelayEmitter(run_id=str(uuid4()), thread_id="t", trace_id="trc")

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[str]:
        from ag_ui.core import EventType, TextMessageContentEvent

        yield em.emit_run_started()
        yield em.emit(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="Hello "
            )
        )
        yield em.emit(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="there."
            )
        )
        yield em.emit_run_finished_success()

    persist = AsyncMock()
    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=persist),
    ):
        resp = tc.post("/ask/stream", json={"message": "hi"})
    assert resp.status_code == 200
    persist.assert_awaited_once()
    kwargs = persist.await_args.kwargs
    assert kwargs["assistant_text"] == "Hello there."


def test_ask_stream_dock_fast_path_skips_react(client, monkeypatch):
    """High-confidence regex bypasses the dock loop and goes to dispatch."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    monkeypatch.setattr(srv, "_DOCK_REGEX_FAST_PATH_THRESHOLD", 0.9)
    tc, _ = client

    async def fake_dispatch(*args, **kwargs):
        return {"agent": "applications", "action": "list", "count": 0, "items": []}

    dock_called = {"n": 0}

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[str]:
        dock_called["n"] += 1
        if False:  # pragma: no cover
            yield ""

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
    assert dock_called["n"] == 0
    intent_evt = next(e for e in events if e.get("event") == "intent")
    assert intent_evt["via"] == "regex_fast_path"


def test_ask_stream_dock_error_emits_run_error(client, monkeypatch):
    """An exception inside the dock turn surfaces as an AG-UI RUN_ERROR frame."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", True)
    monkeypatch.setattr(srv, "_DOCK_REGEX_FAST_PATH_THRESHOLD", 0.99)
    tc, _ = client

    async def fake_run_dock_turn(**_kw) -> AsyncIterator[str]:
        raise RuntimeError("boom")
        yield ""  # pragma: no cover — make it a generator

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post("/ask/stream", json={"message": "do something"})
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    errs = [e for e in events if e.get("type") == "RUN_ERROR"]
    assert len(errs) == 1


# ─────────────────────────────────────────────────────── HITL resume via command


def test_ask_stream_command_resume_routes_to_dock(client, monkeypatch):
    """A body with ``command`` always goes to the dock (resume), even with the
    React flag off, and forwards the command through to run_dock_turn."""
    monkeypatch.setattr(srv, "_DOCK_REACT_ENABLED", False)
    tc, user_id = client
    captured = {}

    async def fake_run_dock_turn(**kw) -> AsyncIterator[str]:
        captured.update(kw)
        em = RelayEmitter(run_id=str(uuid4()), thread_id="t", trace_id="trc")
        yield em.emit_run_started()
        yield em.emit_run_finished_success()

    with (
        patch.object(dock_agent, "run_dock_turn", new=fake_run_dock_turn),
        patch("agents.api.server.persist_turn", new=AsyncMock()),
    ):
        resp = tc.post(
            "/ask/stream",
            json={"message": "", "command": {"resume": "Stripe"}},
            headers={"X-Relay-Thread-Id": f"ask_vantage:{user_id}"},
        )
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    assert any(e.get("type") == "RUN_FINISHED" for e in events)
    assert captured.get("command") == {"resume": "Stripe"}


# ─────────────────────────────────────────────── P0-2 IDOR guard on /ask/stream


def test_ask_stream_rejects_foreign_thread_id(client):
    """Header pointing at another user's thread must yield 403."""
    tc, _ = client
    foreign_thread = f"ask_vantage:{uuid4()}"
    resp = tc.post(
        "/ask/stream",
        json={"message": "hi"},
        headers={"X-Relay-Thread-Id": foreign_thread},
    )
    assert resp.status_code == 403
    body = resp.json()
    err = body.get("error") or body
    msg = err.get("message", "") if isinstance(err, dict) else ""
    assert "not yours" in msg, body


def test_ask_stream_rejects_unknown_thread_shape(client):
    tc, _ = client
    resp = tc.post(
        "/ask/stream",
        json={"message": "hi"},
        headers={"X-Relay-Thread-Id": "bogus-not-a-thread"},
    )
    assert resp.status_code == 403


def test_ask_stream_accepts_own_thread_id(client, monkeypatch):
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
