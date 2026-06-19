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
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


@pytest.fixture
def client():
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def test_submitted_publishes_event_even_when_pg_write_fails(client, monkeypatch):
    tc, user = client
    application_id = uuid4()

    async def fake_pg_query(_sql, _params):
        raise RuntimeError("PG unavailable")

    captured: list[tuple[str, dict]] = []

    async def fake_publish(topic, payload):
        captured.append((topic, payload))
        return "1234-0"

    # NOTE: server's endpoint imports inside the function, so the patch
    # target is the source module, not server.py.
    monkeypatch.setattr("agents.tools.auto.pg_query", fake_pg_query)
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

    # Event fired with the right topic + payload.
    assert len(captured) == 1
    topic, payload = captured[0]
    assert topic == "application:submitted"
    assert payload["user_id"] == str(user)
    assert payload["application_id"] == str(application_id)
    assert payload["company"] == "Synthetic Labs"
    assert payload["role_title"] == "SSE"
    assert payload["submitted_via"] == "client_extension"


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
