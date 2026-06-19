"""Tests for /extension/map-fields — the T7 cloud field-mapping endpoint.

Hermetic: monkeypatch jobmatch + appprep + pg_query so no DB / LLM / network
is touched. Verifies:
- no base résumé → all fields return as unmatched (graceful degrade)
- sensitive fields → skip carried into unmatched, others get fills
- malformed PG content (string vs dict) → still parses
"""
from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from agents.api import server as srv
from agents.api.deps import current_user
from agents.nodes import appprep_agent as appprep
from agents.nodes import jobmatch_agent as jm


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


@pytest.fixture
def client():
    # Override the `current_user` dependency (UserDep is just
    # Annotated[UUID, Depends(current_user)]; FastAPI keys overrides off the
    # underlying callable).
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


SAMPLE_BASE_RESUME = {
    "basics": {"name": "Alice Engineer", "email": "alice@example.com"},
    "work": [{"company": "Synthetic Labs", "position": "Engineer"}],
    "skills": [{"name": "TypeScript"}],
}


async def _fake_parse_jd_ok(url, user_id, persist=True, http_client=None):
    return jm.ParsedJD(
        job_id=uuid4(),
        source="greenhouse",
        external_id="4071234",
        company="Synthetic Labs",
        role_title="SSE",
        jd_text="...",
        parsed={"skills": ["TypeScript"], "level": "senior"},
        url=url,
    )


def test_returns_all_unmatched_when_no_base_resume(client, monkeypatch):
    tc, _user = client

    async def fake_pg_query(_sql, _params):
        return []  # no résumé rows for this user

    monkeypatch.setattr("agents.tools.auto.pg_query", fake_pg_query)

    body = {
        "context": {"source": "greenhouse"},
        "jd_url": "https://boards.greenhouse.io/synthetic/jobs/4071234",
        "fields": [
            {"id": "first_name", "label": "First Name", "type": "text", "selector": "#first_name"},
        ],
    }
    resp = tc.post("/extension/map-fields", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["fills"] == []
    assert len(data["unmatched"]) == 1
    assert data["unmatched"][0]["id"] == "first_name"


def test_maps_answered_fields_and_carries_skips_to_unmatched(client, monkeypatch):
    tc, _user = client

    async def fake_pg_query(_sql, _params):
        return [{"content": SAMPLE_BASE_RESUME}]

    async def fake_form_answers(*, tailored_resume, parsed_jd, fields, user_id):
        return [
            appprep.FormFieldAnswer(
                id="why_us",
                answer="I want to ship great products.",
                skip=False,
                reason=None,
                confidence=0.8,
            ),
            appprep.FormFieldAnswer(
                id="visa_status",
                answer=None,
                skip=True,
                reason="sensitive_field_user_decides",
                confidence=1.0,
            ),
        ]

    monkeypatch.setattr("agents.tools.auto.pg_query", fake_pg_query)
    monkeypatch.setattr(jm, "parse_jd_from_url", _fake_parse_jd_ok)
    monkeypatch.setattr(appprep, "generate_form_answers", fake_form_answers)

    body = {
        "context": {"source": "greenhouse"},
        "jd_url": "https://boards.greenhouse.io/synthetic/jobs/4071234",
        "fields": [
            {"id": "why_us", "label": "Why us?", "type": "textarea", "selector": "#why_us"},
            {
                "id": "visa_status",
                "label": "Visa status",
                "type": "select",
                "selector": "#visa_status",
                "options": ["US Citizen", "Other"],
            },
        ],
    }
    resp = tc.post("/extension/map-fields", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["fills"]) == 1
    fill = data["fills"][0]
    assert fill["selector"] == "#why_us"
    assert fill["value"] == "I want to ship great products."
    assert fill["type"] == "textarea"
    assert fill["confidence"] == 0.8
    assert len(data["unmatched"]) == 1
    assert data["unmatched"][0]["id"] == "visa_status"


def test_handles_resume_stored_as_jsonb_string(client, monkeypatch):
    """Some PG drivers hand JSONB back as the raw string. Endpoint should cope."""
    import json as _json

    tc, _user = client

    async def fake_pg_query(_sql, _params):
        return [{"content": _json.dumps(SAMPLE_BASE_RESUME)}]

    async def fake_form_answers(*, tailored_resume, parsed_jd, fields, user_id):
        # Confirm we received a dict, not a string.
        assert isinstance(tailored_resume, dict)
        assert tailored_resume["basics"]["name"] == "Alice Engineer"
        return []

    monkeypatch.setattr("agents.tools.auto.pg_query", fake_pg_query)
    monkeypatch.setattr(jm, "parse_jd_from_url", _fake_parse_jd_ok)
    monkeypatch.setattr(appprep, "generate_form_answers", fake_form_answers)

    body = {
        "context": {"source": "greenhouse"},
        "jd_url": "https://boards.greenhouse.io/synthetic/jobs/4071234",
        "fields": [{"id": "fld", "label": "Foo", "type": "text", "selector": "#fld"}],
    }
    resp = tc.post("/extension/map-fields", json=body)
    assert resp.status_code == 200


def test_empty_fields_short_circuits(client):
    tc, _user = client
    body = {"context": {"source": "greenhouse"}, "jd_url": "x", "fields": []}
    resp = tc.post("/extension/map-fields", json=body)
    assert resp.status_code == 200
    assert resp.json() == {"fills": [], "unmatched": []}
