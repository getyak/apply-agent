"""Tests for the agents-side v2 error envelope (docs/architecture/error-handling.md).

Covers the round-trip of structured node responses
(``HTTPException(status_code=422, detail={"ok": False, "reason": "..."})``)
into the typed envelope the web layer expects:
  - ``code`` is the v2 ErrorCode (LLM_FABRICATION_BLOCKED / RESOURCE_NOT_FOUND / …)
  - ``messageKey`` is i18n-ready
  - ``traceCode`` is the short R-XXXX form
  - rejected entities surface via ``details.rejectedEntities``
  - ``X-Trace-Id`` echoes back on the response

Driven entirely against ``server.app`` via FastAPI's ``TestClient`` so we
exercise the real middleware + exception-handler stack — no docker, no PG.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from agents.api import server as srv
from agents.api.deps import current_user
from agents.nodes import resume_agent


@pytest.fixture
def client():
    fixed_user = uuid4()

    async def fake_user_dep():
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def _customize_payload() -> dict:
    return {
        "base_resume_id": str(uuid4()),
        "base_version": 1,
        "base_resume_content": {"basics": {"name": "Test"}, "work": []},
        "job_id": str(uuid4()),
        "jd_text": "Engineering role at Stripe.",
    }


# ─────────────────────────────────────────────────────────────────────
# fabrication_guard rejection round-trip → LLM_FABRICATION_BLOCKED
# ─────────────────────────────────────────────────────────────────────


def test_fabrication_rejection_round_trips_as_envelope(client, monkeypatch):
    """When customize fails fabrication_guard, the response MUST carry
    code=LLM_FABRICATION_BLOCKED + fix-input action + rejectedEntities."""
    tc, _user = client

    async def fake_customize(**_kwargs):
        return {
            "ok": False,
            "reason": "fabrication_guard_failed",
            "fabricated": ["company:Stripe Capital", "year:2017", "percent:50%"],
        }

    monkeypatch.setattr(resume_agent, "customize", fake_customize)

    resp = tc.post("/resume/customize", json=_customize_payload())
    assert resp.status_code == 422
    body = resp.json()
    assert "error" in body
    err = body["error"]
    assert err["code"] == "LLM_FABRICATION_BLOCKED"
    assert err["messageKey"] == "errors.llm.fabricationBlocked"
    assert err["action"] == {"kind": "fix-input", "fields": []}
    assert err["details"]["rejectedEntities"] == [
        "company:Stripe Capital",
        "year:2017",
        "percent:50%",
    ]
    # traceCode + traceId both present
    assert err["traceCode"].startswith("R-")
    assert isinstance(err["traceId"], str) and len(err["traceId"]) == 36
    # Header echo so the gateway can stitch logs
    assert resp.headers["X-Trace-Id"] == err["traceId"]


# ─────────────────────────────────────────────────────────────────────
# Inbound X-Trace-Id continuity (gateway → agents)
# ─────────────────────────────────────────────────────────────────────


def test_inbound_trace_id_is_echoed(client, monkeypatch):
    """Gateway-supplied trace id must flow through unchanged so cross-layer
    correlation works (error-handling.md §5)."""
    tc, _user = client
    inbound = "01935f4e-aaaa-bbbb-cccc-deadbeef1234"

    async def fake_customize(**_kwargs):
        return {"ok": False, "reason": "resume_not_found"}

    monkeypatch.setattr(resume_agent, "customize", fake_customize)

    resp = tc.post(
        "/resume/customize",
        json=_customize_payload(),
        headers={"X-Trace-Id": inbound},
    )
    body = resp.json()
    assert resp.headers["X-Trace-Id"] == inbound
    assert body["error"]["traceId"] == inbound
    # And it's mapped to RESOURCE_NOT_FOUND (not the previous "INTERNAL"
    # bucket that the bare-status fallback produced).
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND"
    assert body["error"]["messageKey"] == "errors.resource.notFound"


# ─────────────────────────────────────────────────────────────────────
# Resource-not-found mapping
# ─────────────────────────────────────────────────────────────────────


def test_optimize_resume_not_found_maps_to_resource_not_found(client, monkeypatch):
    tc, _user = client

    async def fake_optimize(*_args, **_kwargs):
        return {"ok": False, "reason": "resume_not_found"}

    monkeypatch.setattr(resume_agent, "optimize_general", fake_optimize)

    resp = tc.post("/resume/optimize", json={"base_resume_id": str(uuid4())})
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "RESOURCE_NOT_FOUND"
    assert err["messageKey"] == "errors.resource.notFound"


# ─────────────────────────────────────────────────────────────────────
# String-detail (404) still works (backward compat)
# ─────────────────────────────────────────────────────────────────────


def test_string_detail_still_maps_by_status(client, monkeypatch):
    """Pre-existing call sites that raise HTTPException with a string detail
    must keep working (status-code-only fallback)."""
    tc, _user = client

    async def fake_get_suggestion(_sid, _user):
        return None  # → route raises HTTPException(404, "suggestion not found")

    monkeypatch.setattr("agents.nodes.resume_store.get_suggestion", fake_get_suggestion)

    resp = tc.post(
        f"/resume/suggestions/{uuid4()}/decision",
        json={"decision": "reject"},
    )
    assert resp.status_code == 404
    err = resp.json()["error"]
    assert err["code"] == "RESOURCE_NOT_FOUND"
    # String detail still passes through as the human message
    assert err["message"] == "suggestion not found"


# ─────────────────────────────────────────────────────────────────────
# Direct envelope helper unit test
# ─────────────────────────────────────────────────────────────────────


def test_envelope_helper_unknown_reason_returns_none():
    out = srv._envelope_from_dict_detail({"reason": "neverHeardOfIt"}, 422)
    assert out is None


def test_envelope_helper_no_reason_returns_none():
    out = srv._envelope_from_dict_detail({"ok": False}, 422)
    assert out is None


def test_envelope_helper_caps_fabricated_list_at_20():
    fabricated = [f"company:Fake{i}" for i in range(40)]
    out = srv._envelope_from_dict_detail(
        {"reason": "fabrication_guard_failed", "fabricated": fabricated}, 422
    )
    assert out is not None
    assert len(out["details"]["rejectedEntities"]) == 20


def test_envelope_helper_no_fabricated_no_details():
    out = srv._envelope_from_dict_detail({"reason": "resume_not_found"}, 422)
    assert out is not None
    assert "details" not in out
    assert out["code"] == "RESOURCE_NOT_FOUND"


def test_envelope_helper_dispatches_to_validation_codes():
    for reason in ("no_valid_suggestions", "no_edit"):
        out = srv._envelope_from_dict_detail({"reason": reason}, 422)
        assert out is not None
        assert out["code"] == "VALIDATION_FAILED"
        assert out["messageKey"] == "errors.validation.failed"


def test_envelope_helper_dispatches_bullet_not_found_to_not_found():
    out = srv._envelope_from_dict_detail({"reason": "bullet_not_found"}, 422)
    assert out is not None
    assert out["code"] == "RESOURCE_NOT_FOUND"


# ─────────────────────────────────────────────────────────────────────
# Status-code map regression — 422 / 402 / 410 are now mapped
# ─────────────────────────────────────────────────────────────────────


def test_http_status_code_map_covers_new_statuses():
    assert srv._http_status_code(422) == "VALIDATION_FAILED"
    assert srv._http_status_code(402) == "LLM_BUDGET_EXHAUSTED"
    assert srv._http_status_code(410) == "RESOURCE_GONE"
    # 418 is still a teapot → INTERNAL fallback
    assert srv._http_status_code(418) == "INTERNAL"


# ─────────────────────────────────────────────────────────────────────
# Envelope still works when raised directly (no wrapping route)
# ─────────────────────────────────────────────────────────────────────


def test_envelope_for_raised_dict_detail_via_handler():
    """Smoke: simulate the exception handler's path against a synthetic
    HTTPException."""

    class _R:
        state = type("S", (), {"trace_id": "ffffffff-ffff-ffff-ffff-ffffffffffff"})()

    exc = HTTPException(
        status_code=422,
        detail={
            "ok": False,
            "reason": "fabrication_guard_failed",
            "fabricated": ["company:X"],
        },
    )
    env = srv._error_envelope(exc, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    assert env["code"] == "LLM_FABRICATION_BLOCKED"
    assert env["details"]["rejectedEntities"] == ["company:X"]
    assert env["traceCode"].startswith("R-")
    # Internal "status" book-keeping never leaks out
    assert "status" not in env
