"""Unit tests for P2-3 — find_jobs backed by real ingested data.

Locks down:
  - Empty jobs table → status="empty", items=[], honest message
  - Role filter is ILIKE-substring
  - remote_only adds a second ILIKE clause
  - PG error degrades to status="error" without raising
  - Limit clamps to [1, 25]
  - Result items have stable shape (id, company, role_title, url, posted_date)
"""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agents.coordinator import dock_tools


@pytest.fixture
def _set_dock_user():
    tokens = dock_tools.set_dock_context(
        user_id=uuid4(), thread_id="ask_vantage:test", surface="dock"
    )
    yield
    dock_tools.reset_dock_context(tokens)


async def test_find_jobs_empty_table_returns_empty_status(_set_dock_user):
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=[])):
        out = await dock_tools.find_jobs.ainvoke({"role": "backend"})
    assert out["status"] == "empty"
    assert out["items"] == []
    assert "no jobs" in out["summary"].lower()


async def test_find_jobs_returns_rows(_set_dock_user):
    rows = [
        {
            "id": uuid4(),
            "company": "Stripe",
            "role_title": "Senior Backend Engineer",
            "url": "https://example.com/1",
            "posted_date": datetime(2026, 6, 20),
        },
        {
            "id": uuid4(),
            "company": "Anthropic",
            "role_title": "Member of Technical Staff",
            "url": "https://example.com/2",
            "posted_date": None,
        },
    ]
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=rows)):
        out = await dock_tools.find_jobs.ainvoke({"limit": 5})
    assert out["status"] == "ok"
    assert out["count"] == 2
    assert out["items"][0]["company"] == "Stripe"
    assert out["items"][0]["posted_date"] == "2026-06-20T00:00:00"
    assert out["items"][1]["posted_date"] is None


async def test_find_jobs_role_filter_uses_ilike(_set_dock_user):
    captured: dict = {}

    async def fake_pg(sql, params=()):
        captured["sql"] = sql
        captured["params"] = params
        return []

    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake_pg)):
        await dock_tools.find_jobs.ainvoke({"role": "backend"})

    assert "ILIKE" in captured["sql"]
    assert "%backend%" in captured["params"]


async def test_find_jobs_remote_only_adds_clause(_set_dock_user):
    captured: dict = {}

    async def fake_pg(sql, params=()):
        captured["sql"] = sql
        captured["params"] = params
        return []

    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake_pg)):
        await dock_tools.find_jobs.ainvoke({"remote_only": True})

    assert "%remote%" in captured["params"]


async def test_find_jobs_pg_error_returns_status_error(_set_dock_user):
    with patch(
        "agents.tools.auto.pg_query",
        new=AsyncMock(side_effect=ConnectionError("PG down")),
    ):
        out = await dock_tools.find_jobs.ainvoke({})
    assert out["status"] == "error"
    assert out["items"] == []


async def test_find_jobs_clamps_limit_high(_set_dock_user):
    """limit > 25 → 25."""
    captured: dict = {}

    async def fake_pg(sql, params=()):
        captured["params"] = params
        return []

    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake_pg)):
        await dock_tools.find_jobs.ainvoke({"limit": 999})
    assert 25 in captured["params"]


async def test_find_jobs_clamps_limit_negative(_set_dock_user):
    """Negative limit → clamped to 1. (limit=0 falls through to default 10
    because ``int(0 or 10)`` == 10 — that's a soft "use default" semantic.)"""
    captured: dict = {}

    async def fake_pg(sql, params=()):
        captured["params"] = params
        return []

    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake_pg)):
        await dock_tools.find_jobs.ainvoke({"limit": -5})
    assert 1 in captured["params"]
