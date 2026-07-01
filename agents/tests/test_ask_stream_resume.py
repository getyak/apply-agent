"""HTTP-level integration tests for /ask/stream resume-by-cursor (D3).

These tests need real PG (RELAY_PG_DSN set) because the persistence
substrate is only reachable when psycopg can connect. They seed a few
frames into ask_stream_events for a synthetic thread_id, then POST to
/ask/stream with a ``Last-Event-ID`` header and assert:

  * frames > cursor are streamed back verbatim
  * expired-buffer path emits ``event: stream_expired``
  * an ``X-Relay-Resume: 1`` response header advertises the branch to
    the client so it can distinguish resume from a fresh turn

We reuse the same env-snapshot prologue as test_ask_stream_dock_route so
importing srv doesn't poison the pytest session env.
"""

from __future__ import annotations

import atexit
import json
import os
import uuid

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
from agents.harness.stream_events import StreamPersistence  # noqa: E402

_restore_env_snapshot()

_HAS_PG = bool(os.environ.get("RELAY_PG_DSN"))
requires_pg = pytest.mark.skipif(not _HAS_PG, reason="no local RELAY_PG_DSN")


def _agui_frame(seq_hint: int, ulid_prefix: str) -> str:
    envelope = {
        "id": f"{ulid_prefix}{seq_hint:010d}",
        "seq": seq_hint,
        "trace_id": "test-trace",
        "run_id": "run_test",
        "thread_id": "ask_vantage:test",
        "protocol_version": "agui-0.1.19+relay-1",
    }
    body = {
        "type": "TEXT_MESSAGE_CONTENT",
        "messageId": f"msg_{seq_hint}",
        "delta": f"chunk_{seq_hint}",
        "rawEvent": envelope,
    }
    return f"data: {json.dumps(body)}\n\n"


@pytest.fixture
def client_with_pg(monkeypatch):
    """TestClient with a fixed user + PG DSN forced through to the app.

    Also disables the resume-branch live tail (RELAY_STREAM_RESUME_IDLE_S=0)
    so the response completes as soon as PG replay drains — otherwise the
    test would sit on a 30 s Redis Pub/Sub wait for events that never come.
    """
    fixed_user = uuid.uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    if _HAS_PG:
        monkeypatch.setenv("RELAY_PG_DSN", os.environ["RELAY_PG_DSN"])
    monkeypatch.setenv("RELAY_STREAM_RESUME_IDLE_S", "0")
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


@requires_pg
def test_resume_serves_missed_frames(client_with_pg):
    """POST with Last-Event-ID → frames with sequence > cursor stream back."""
    tc, user = client_with_pg
    thread_id = f"ask_vantage:{user}"

    # Seed three frames.
    import asyncio

    p = StreamPersistence(thread_id=thread_id)

    async def seed():
        await p.initialize()
        for i in (1, 2, 3):
            await p.persist(_agui_frame(i, ulid_prefix="01RSU"))

    asyncio.run(seed())

    # Resume from cursor=1 → should get seq 2 and 3.
    resp = tc.post(
        "/ask/stream",
        json={"message": ""},
        headers={
            "Last-Event-ID": "1",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("X-Relay-Resume") == "1"

    body = resp.text
    # Frames come back with their persisted id: <seq> line.
    assert "id: 2\n" in body
    assert "id: 3\n" in body
    assert "id: 1\n" not in body  # cursor was 1 → nothing at or below returned
    assert "chunk_2" in body
    assert "chunk_3" in body


@requires_pg
def test_resume_expired_emits_stream_expired(client_with_pg):
    """Cursor for a thread with no rows → stream_expired frame."""
    tc, user = client_with_pg
    thread_id = f"ask_vantage:{user}"

    # No seed — the buffer for this thread is empty. Cursor > 0 →
    # expired path fires. Clean up in case a prior test left rows.
    import asyncio

    import psycopg

    async def clean():
        async with await psycopg.AsyncConnection.connect(os.environ["RELAY_PG_DSN"]) as conn:
            async with conn.cursor() as cur:
                await cur.execute("DELETE FROM ask_stream_events WHERE thread_id = %s", (thread_id,))
            await conn.commit()

    asyncio.run(clean())

    resp = tc.post(
        "/ask/stream",
        json={"message": ""},
        headers={
            "Last-Event-ID": "42",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("X-Relay-Resume") == "1"
    assert "event: stream_expired" in resp.text


@requires_pg
def test_resume_body_field_also_accepted(client_with_pg):
    """POST body ``last_event_id`` works when the client can't set headers."""
    tc, user = client_with_pg
    thread_id = f"ask_vantage:{user}"

    import asyncio

    p = StreamPersistence(thread_id=thread_id)

    async def seed():
        await p.initialize()
        await p.persist(_agui_frame(1, ulid_prefix="01BDY"))
        await p.persist(_agui_frame(2, ulid_prefix="01BDY"))

    asyncio.run(seed())

    resp = tc.post(
        "/ask/stream",
        json={"message": "", "last_event_id": 1},
    )
    assert resp.status_code == 200
    assert resp.headers.get("X-Relay-Resume") == "1"
    assert "id: 2\n" in resp.text
    assert "chunk_2" in resp.text
