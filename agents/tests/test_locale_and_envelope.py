"""Round-20 regressions:
  - `/applications/prepare` echoes X-Relay-Locale + includes ui_locale in JSON
  - error envelope on HTTPException paths populates `action` per
    docs/architecture/error-handling.md § 1 P4 (every code → UI CTA)

Both deltas keep web's `<ErrorToast/Inline/Banner>` from rendering a faceless
500 message; the action is what makes the "Reauth / Retry / Fix input" CTAs
land in the right surface.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from agents.api.server import _default_action_for, _normalise_ui_locale, app


@pytest.fixture
def client():
    return TestClient(app)


# ── locale normalisation table ──────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, "en"),
        ("", "en"),
        ("   ", "en"),
        ("en", "en"),
        ("EN", "en"),
        ("en-US", "en"),
        ("en_us", "en"),
        ("zh", "zh"),
        ("zh-CN", "zh"),
        ("zh-TW", "zh"),
        ("zh-Hans;q=0.9,en;q=0.5", "zh"),
        # Unknown languages collapse to en so the response header is always sane
        ("ja", "en"),
        ("fr", "en"),
        ("not-a-locale", "en"),
        # Non-string input shouldn't crash
        (123, "en"),
    ],
)
def test_normalise_ui_locale(raw, expected):
    assert _normalise_ui_locale(raw) == expected  # type: ignore[arg-type]


# ── envelope `action` table — every code in the dictionary has a CTA ───


@pytest.mark.parametrize(
    "code,expected_kind",
    [
        ("AUTH_REQUIRED", "reauth"),
        ("AUTH_SESSION_EXPIRED", "reauth"),
        ("AUTH_INVALID_CREDENTIALS", "none"),
        ("AUTH_FORBIDDEN", "none"),
        ("VALIDATION_FAILED", "fix-input"),
        ("INPUT_FORMAT_UNSUPPORTED", "fix-input"),
        ("RESOURCE_NOT_FOUND", "none"),
        ("RESOURCE_CONFLICT", "none"),
        ("RESOURCE_GONE", "none"),
        ("RATE_LIMITED", "retry"),
        ("QUOTA_EXCEEDED", "contact"),
        ("UPSTREAM_TIMEOUT", "retry"),
        ("UPSTREAM_UNAVAILABLE", "retry"),
        ("DB_UNAVAILABLE", "retry"),
        ("CACHE_UNAVAILABLE", "retry"),
        ("LLM_UNAVAILABLE", "retry"),
        ("INTERNAL_BIZARRE_CODE", "none"),  # fallback bucket
    ],
)
def test_default_action_for(code, expected_kind):
    assert _default_action_for(code)["kind"] == expected_kind


# ── live HTTP probe: AUTH_REQUIRED carries reauth action ───────────────


def test_prepare_application_missing_auth_returns_action(client):
    """No X-Relay-User-Id → 401 AUTH_REQUIRED with reauth action populated.

    Round-20 fix: before this round, the HTTPException branch of
    _error_envelope only emitted code/messageKey but no `action`. The web
    `resolveError()` layer had to fall back to {kind: "none"} for every
    auth failure — meaning the AuthRequired toast never auto-routed to
    /auth. Now the agent layer emits it natively.
    """
    resp = client.post("/applications/prepare", json={"bogus": "data"})
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "AUTH_REQUIRED"
    assert body["error"]["action"] == {"kind": "reauth", "redirect": "/auth"}
    # trace headers come through as well
    assert "x-trace-id" in resp.headers


def test_prepare_application_invalid_user_id_returns_validation_action(client):
    """Bad UUID in X-Relay-User-Id → 400 VALIDATION_FAILED with fix-input action."""
    resp = client.post(
        "/applications/prepare",
        json={"bogus": "data"},
        headers={"X-Relay-User-Id": "not-a-uuid"},
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_FAILED"
    assert body["error"]["action"]["kind"] == "fix-input"


# ── live HTTP probe: X-Relay-Locale echoes on response + payload ──────


def _minimal_prepare_payload() -> dict[str, Any]:
    return {
        "jd_url": "https://boards.greenhouse.io/synthetic/jobs/4071234",
        "base_resume_id": str(uuid4()),
        "base_resume_content": {"basics": {"name": "Alice"}, "work": [], "skills": []},
        "base_resume_version": 1,
        "form_fields": [],
        "application_id": str(uuid4()),
    }


@pytest.mark.parametrize("raw,expected", [("zh", "zh"), ("zh-CN", "zh"), ("en-US", "en")])
def test_prepare_application_echoes_locale(client, raw, expected):
    """X-Relay-Locale on the request → response header + ui_locale in payload."""
    payload = _minimal_prepare_payload()
    resp = client.post(
        "/applications/prepare",
        json=payload,
        headers={
            "X-Relay-User-Id": str(uuid4()),
            "X-Relay-Locale": raw,
        },
    )
    # The locale echo must hold whether the saga returned 200 or not.
    # (Live JD fetch will probably 403 in CI without the fixture — so the
    # saga marks parse_jd failed, but still returns 200 with the locale
    # echo because the response shape is the same.)
    assert resp.status_code == 200
    assert resp.headers.get("x-relay-locale") == expected
    body = resp.json()
    assert body["ui_locale"] == expected


def test_prepare_application_defaults_locale_to_en(client):
    """No X-Relay-Locale → en echo (not empty / None)."""
    payload = _minimal_prepare_payload()
    resp = client.post(
        "/applications/prepare",
        json=payload,
        headers={"X-Relay-User-Id": str(uuid4())},
    )
    assert resp.status_code == 200
    assert resp.headers.get("x-relay-locale") == "en"
    assert resp.json()["ui_locale"] == "en"
