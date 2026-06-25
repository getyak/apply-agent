"""Unit tests for agents/coordinator/user_brief.py — the per-turn user context.

Locks down the P1-2 fix:
  - No PG (empty pg_query) → empty brief, no crash
  - Single section returned when only one query has data
  - Multiple sections concatenated in priority order
  - Failed query degrades silently to empty section
  - Headline / list / weak-point / preferences shapes are correct
  - Date formatting yields YYYY-MM-DD

We monkeypatch agents.tools.auto.pg_query because that's the only PG
touch — keeps the test hermetic without needing the integration harness.
"""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agents.coordinator.user_brief import build_user_brief


@pytest.fixture
def user_id():
    return uuid4()


def _patch_pg(rows_by_sql: dict[str, list[dict]]):
    """Return a patch context that routes pg_query by SQL substring."""

    async def fake(sql: str, params=()):
        for needle, rows in rows_by_sql.items():
            if needle in sql:
                return rows
        return []

    return patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake))


# ─────────────────────────────────────────────────────────────────────
# Whole-brief assembly
# ─────────────────────────────────────────────────────────────────────


async def test_empty_pg_yields_empty_brief(user_id):
    """New user / no PG / all queries empty → empty string."""
    with _patch_pg({}):
        out = await build_user_brief(user_id)
    assert out == ""


async def test_single_section_works(user_id):
    """Only one query has data — brief still renders that section."""
    rows = {
        "FROM resumes": [
            {
                "id": uuid4(),
                "version": 7,
                "content": {
                    "basics": {"name": "Alex Chen", "summary": "Backend at Stripe."}
                },
                "track": "tailored",
                "is_base": False,
                "updated_at": None,
            }
        ]
    }
    with _patch_pg(rows):
        out = await build_user_brief(user_id)
    assert "What you remember about this user" in out
    assert "Alex Chen" in out
    assert "v7" in out
    assert "tailored" in out
    assert "Backend at Stripe" in out
    # Sections we DIDN'T populate must be absent.
    assert "Recent applications" not in out
    assert "weak points" not in out


async def test_full_brief_has_all_sections_in_order(user_id):
    rows = {
        "FROM resumes": [
            {
                "id": uuid4(),
                "version": 3,
                "content": {"basics": {"label": "Senior PM"}},
                "track": "base",
                "is_base": True,
                "updated_at": None,
            }
        ],
        "FROM application_drafts": [
            {
                "id": uuid4(),
                "status": "submitted",
                "submitted_at": datetime(2026, 6, 1),
                "outcome": None,
                "company": "Stripe",
                "role_title": "Staff PM",
            },
            {
                "id": uuid4(),
                "status": "interview",
                "submitted_at": datetime(2026, 5, 28),
                "outcome": "passed_phone",
                "company": "Linear",
                "role_title": "PM, Growth",
            },
        ],
        "FROM interview_sessions": [
            {
                "weak_points": [
                    {"skill": "Owning impact", "confidence": 0.3},
                    {"skill": "Trade-off articulation", "confidence": 0.45},
                ],
                "completed_at": None,
            }
        ],
        "FROM users": [
            {
                "preferences": {
                    "target_roles": ["PM", "PMM"],
                    "locations": ["SF", "Remote"],
                    "remote": True,
                    "skills": ["growth", "experimentation", "SQL"],
                }
            }
        ],
    }
    with _patch_pg(rows):
        out = await build_user_brief(user_id)

    # Priority order: Résumé → Applications → Weak points → Preferences
    assert out.index("### Résumé") < out.index("### Recent applications")
    assert out.index("### Recent applications") < out.index("### Interview weak points")
    assert out.index("### Interview weak points") < out.index("### Preferences")

    # Each section's specifics:
    assert "Senior PM" in out
    assert "Stripe — Staff PM" in out
    assert "Linear — PM, Growth" in out
    assert "2026-06-01" in out  # date format
    assert "outcome=passed_phone" in out
    assert "Owning impact" in out
    assert "30%" in out  # confidence formatting
    assert "target roles: PM, PMM" in out
    assert "remote OK" in out
    assert "growth, experimentation, SQL" in out


async def test_query_failure_degrades_silently(user_id):
    """If a PG query raises, the section is omitted but other sections survive."""

    async def fake(sql: str, params=()):
        if "FROM resumes" in sql:
            raise ConnectionError("PG just died")
        if "FROM application_drafts" in sql:
            return [
                {
                    "id": uuid4(),
                    "status": "draft",
                    "submitted_at": None,
                    "outcome": None,
                    "company": "Anthropic",
                    "role_title": "MTS",
                }
            ]
        return []

    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake)):
        out = await build_user_brief(user_id)

    # Résumé section missing, applications present.
    assert "Résumé" not in out
    assert "Anthropic — MTS" in out


async def test_json_string_content_is_decoded(user_id):
    """resumes.content arriving as a JSON string (legacy path) is parsed."""
    rows = {
        "FROM resumes": [
            {
                "id": uuid4(),
                "version": 1,
                # PG psycopg sometimes returns JSONB as str, sometimes dict.
                "content": '{"basics": {"name": "Test User"}}',
                "track": "base",
                "is_base": True,
                "updated_at": None,
            }
        ]
    }
    with _patch_pg(rows):
        out = await build_user_brief(user_id)
    assert "Test User" in out


async def test_weak_points_skips_malformed_entries(user_id):
    """Non-dict items in weak_points must be ignored, not crash."""
    rows = {
        "FROM interview_sessions": [
            {
                "weak_points": [
                    {"skill": "Real one", "confidence": 0.5},
                    "not a dict",  # malformed
                    {"topic": "alt key"},  # uses 'topic' not 'skill'
                ],
                "completed_at": None,
            }
        ]
    }
    with _patch_pg(rows):
        out = await build_user_brief(user_id)
    assert "Real one" in out
    assert "alt key" in out
    assert "not a dict" not in out
