"""Regression tests for the unified error envelope across edge paths.

Pins two behaviors that previously bypassed the v2 envelope (docs/architecture/
error-handling.md § P3 "跨三层用同一个信封"):

1. Unknown-route 404: Starlette's router raises ``starlette.exceptions.HTTPException``,
   which is the *parent* of FastAPI's ``HTTPException``. The pre-fix
   ``@app.exception_handler(HTTPException)`` only caught the subclass, so 404s
   came back as bare ``{"detail":"Not Found"}``. Now they go through the v2
   envelope with ``code=RESOURCE_NOT_FOUND``.

2. X-Relay-Locale echo: the agents layer echoes ``X-Relay-Locale`` back on
   every response (en/zh only). The web client uses this as the cheap
   continuity signal that the agents-side honoured the requested UI locale
   (vantage-ui-mapping.md two-dim locale). Only the ``/ask/stream`` route
   previously forwarded the header; other endpoints dropped it on the floor.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agents.api import server as srv


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


@pytest.fixture
def client():
    return TestClient(srv.app)


def test_unknown_route_returns_v2_envelope_with_resource_not_found(client):
    """Pre-fix bug: bare ``{"detail":"Not Found"}``. Post-fix: full envelope."""
    trace = "01935f4e-aaaa-bbbb-cccc-deadbeef9999"
    resp = client.post("/this-route-does-not-exist", headers={"X-Trace-Id": trace})
    assert resp.status_code == 404
    body = resp.json()
    assert set(body.keys()) == {"error"}
    err = body["error"]
    assert err["code"] == "RESOURCE_NOT_FOUND", err
    assert err["traceId"] == trace
    # Both new camelCase and legacy snake_case carry the same trace_id (back-compat).
    assert err["trace_id"] == trace
    # traceCode follows the R-XXXX form derived from traceId hex (§5.2).
    assert err["traceCode"].startswith("R-") and len(err["traceCode"]) == 6
    assert err["messageKey"].startswith("errors.resource.")
    assert "timestamp" in err
    # X-Trace-Id always echoed.
    assert resp.headers["x-trace-id"] == trace


def test_unknown_route_404_with_zh_locale_is_echoed(client):
    resp = client.post(
        "/this-route-does-not-exist",
        headers={"X-Trace-Id": "01935f4e-aaaa-bbbb-cccc-deadbeef9999", "X-Relay-Locale": "zh"},
    )
    assert resp.status_code == 404
    assert resp.headers.get("x-relay-locale") == "zh"


def test_healthz_echoes_zh_locale(client):
    resp = client.get("/healthz", headers={"X-Relay-Locale": "zh"})
    assert resp.status_code == 200
    assert resp.headers.get("x-relay-locale") == "zh"


def test_healthz_echoes_en_locale(client):
    resp = client.get("/healthz", headers={"X-Relay-Locale": "en"})
    assert resp.status_code == 200
    assert resp.headers.get("x-relay-locale") == "en"


def test_unknown_locale_is_not_echoed(client):
    """Garbage input: no header echoed (don't reflect attacker-controlled values)."""
    resp = client.get("/healthz", headers={"X-Relay-Locale": "xx-garbage"})
    assert resp.status_code == 200
    assert "x-relay-locale" not in {k.lower() for k in resp.headers.keys()}


def test_unknown_method_405_routes_through_envelope(client):
    """``/healthz`` is GET-only — POST should 405 *through* the envelope."""
    resp = client.post(
        "/healthz",
        headers={"X-Trace-Id": "01935f4e-aaaa-bbbb-cccc-deadbeef9999"},
    )
    assert resp.status_code == 405
    body = resp.json()
    # 405 currently maps to INTERNAL in _http_status_code (the table only
    # covers a curated subset). Importantly: it goes through the envelope
    # rather than returning bare {"detail":...}. Pin the envelope shape.
    err = body["error"]
    assert "traceId" in err
    assert err["traceCode"].startswith("R-")
    assert "code" in err
    assert err["messageKey"].startswith("errors.")
