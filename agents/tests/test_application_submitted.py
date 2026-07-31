"""Tests for /applications/{id}/submitted (T8 — flywheel event bus).

Hermetic: monkeypatch publish() so we don't need Redis; verify the consumers
module wires the same topic.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from agents.api import server as srv
from agents.api.deps import current_user
from agents.events import bus, consumers


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    for name in ("RELAY_PG_DSN", "DATABASE_URL", "POSTGRES_URL"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client():
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def test_submitted_publishes_degraded_event_when_pg_is_unconfigured(client, monkeypatch):
    tc, user = client
    application_id = uuid4()

    captured: list[tuple[str, dict]] = []

    async def fake_publish(topic, payload):
        captured.append((topic, payload))
        return "1234-0"

    monkeypatch.setattr(bus, "publish", fake_publish)

    resp = tc.post(
        f"/applications/{application_id}/submitted",
        json={"company": "Synthetic Labs", "role_title": "SSE"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["event_id"] == "1234-0"
    assert data["application_id"] == str(application_id)
    assert data["db_persisted"] is False
    assert data["transition_changed"] is False

    # Event fired with the right topic + payload.
    assert len(captured) == 1
    topic, payload = captured[0]
    assert topic == "application:submitted"
    assert payload["user_id"] == str(user)
    assert payload["application_id"] == str(application_id)
    assert payload["company"] == "Synthetic Labs"
    assert payload["role_title"] == "SSE"
    assert payload["submitted_via"] == "client_extension"
    assert payload["db_persisted"] is False
    assert payload["transition_changed"] is False


def test_submitted_uses_a_real_write_transaction_when_pg_is_configured(
    client,
    monkeypatch,
):
    tc, _user = client
    application_id = uuid4()
    executed: list[tuple[str, tuple | None]] = []
    committed = False

    class FakeCursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def execute(self, sql, params=None):
            executed.append((sql, params))

        async def fetchone(self):
            if "SELECT status, submitted_at" in executed[-1][0]:
                return ("review", None, None)
            return (application_id,)

    class FakeConnection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def cursor(self):
            return FakeCursor()

        async def commit(self):
            nonlocal committed
            committed = True

    async def fake_connect(_dsn):
        return FakeConnection()

    async def fake_publish(_topic, _payload):
        return "2345-0"

    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://synthetic")
    monkeypatch.setattr("psycopg.AsyncConnection.connect", fake_connect)
    monkeypatch.setattr(bus, "publish", fake_publish)

    resp = tc.post(
        f"/applications/{application_id}/submitted",
        json={"company": "Synthetic Labs", "role_title": "SSE"},
    )

    assert resp.status_code == 200
    assert resp.json()["db_persisted"] is True
    assert resp.json()["transition_changed"] is True
    assert committed is True
    assert any("set_config" in sql for sql, _params in executed)
    assert any("SELECT status, submitted_at" in sql for sql, _params in executed)
    assert any("UPDATE application_drafts" in sql for sql, _params in executed)
    assert any("RETURNING id" in sql for sql, _params in executed)


def test_submitted_commit_failure_reports_degraded_without_claiming_a_transition(
    client,
    monkeypatch,
):
    tc, _user = client
    application_id = uuid4()
    captured: list[dict] = []

    class FakeCursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def execute(self, sql, _params=None):
            self.last_sql = sql

        async def fetchone(self):
            if "SELECT status, submitted_at" in self.last_sql:
                return ("review", None, None)
            return (application_id,)

    class FakeConnection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def cursor(self):
            return FakeCursor()

        async def commit(self):
            raise RuntimeError("synthetic commit failure")

    async def fake_connect(_dsn):
        return FakeConnection()

    async def fake_publish(_topic, payload):
        captured.append(payload)
        return "3456-0"

    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://synthetic")
    monkeypatch.setattr("psycopg.AsyncConnection.connect", fake_connect)
    monkeypatch.setattr(bus, "publish", fake_publish)

    resp = tc.post(f"/applications/{application_id}/submitted", json={})

    assert resp.status_code == 200
    assert resp.json()["db_persisted"] is False
    assert resp.json()["transition_changed"] is False
    assert resp.json()["event_id"] == "3456-0"
    assert captured[0]["db_persisted"] is False
    assert captured[0]["transition_changed"] is False


def test_submitted_rejects_unknown_channel(client):
    tc, _user = client
    resp = tc.post(
        f"/applications/{uuid4()}/submitted",
        json={"submitted_via": "server_bot"},
    )
    assert resp.status_code == 422


def test_submitted_retry_does_not_regress_a_later_stage_or_republish(
    client,
    monkeypatch,
):
    tc, _user = client
    application_id = uuid4()
    executed: list[str] = []

    class FakeCursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def execute(self, sql, _params=None):
            executed.append(sql)

        async def fetchone(self):
            return ("interview", "2026-08-01T00:00:00Z", "client_extension")

    class FakeConnection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def cursor(self):
            return FakeCursor()

        async def commit(self):
            return None

    async def fake_connect(_dsn):
        return FakeConnection()

    async def unexpected_publish(_topic, _payload):
        raise AssertionError("idempotent retry must not republish")

    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://synthetic")
    monkeypatch.setattr("psycopg.AsyncConnection.connect", fake_connect)
    monkeypatch.setattr(bus, "publish", unexpected_publish)

    resp = tc.post(f"/applications/{application_id}/submitted", json={})

    assert resp.status_code == 200
    assert resp.json()["db_persisted"] is True
    assert resp.json()["transition_changed"] is False
    assert resp.json()["event_id"] is None
    assert not any("UPDATE application_drafts" in sql for sql in executed)


def test_consumers_module_subscribes_to_same_topic():
    """Wire alignment — endpoint and consumer must agree on the topic."""
    assert consumers.TOPIC == "application:submitted"
    # Both built-in consumers present so flywheel slots are reserved.
    consumer_names = [c.__name__ for c in consumers.CONSUMERS]
    assert "interview_agent_preheat" in consumer_names
    assert "trend_agent_signal" in consumer_names


async def test_consumers_log_and_keep_pumping_on_failure(monkeypatch):
    """A buggy consumer must not stop the pump for the other consumers."""
    delivered: list[str] = []

    async def good(entry):
        delivered.append(f"good:{entry['id']}")

    async def boom(_entry):
        raise RuntimeError("simulated consumer crash")

    # Replace built-ins with our two.
    monkeypatch.setattr(consumers, "CONSUMERS", [boom, good])

    # Replace subscribe() with a generator that emits one canned entry
    # then completes (so the task exits cleanly).
    async def fake_subscribe(topic, last_id="$"):
        yield {"id": "1-0", "data": {"user_id": "u"}}
        # done

    monkeypatch.setattr(consumers, "subscribe", fake_subscribe)

    await consumers.run_application_submitted_consumers()

    # `good` ran even though `boom` raised first.
    assert delivered == ["good:1-0"]
