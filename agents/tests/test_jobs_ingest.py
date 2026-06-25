"""Unit tests for agents/jobs/{sources,ingest}.py — public ATS ingestion.

Locks down the P1-3 fix:
  - Greenhouse fetcher parses {jobs: [...]} into normalised rows
  - Lever fetcher parses list response (different shape)
  - Ashby fetcher parses {jobs: [...]} (Greenhouse-like but different fields)
  - HTTP failure on one board → empty list, never raise
  - ingest_all keeps going if one board crashes
  - DEFAULT_BOARDS covers all three sources

We hermetic-mock httpx via MockTransport — no real network. PG side is
gated by RELAY_PG_DSN; tests run without it so upsert is a no-op (the
"no DSN → 0 upserted" path).
"""
from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

import httpx
import pytest

from agents.jobs import ingest
from agents.jobs.sources import fetch_ashby, fetch_greenhouse, fetch_lever


@pytest.fixture(autouse=True)
def _no_pg(monkeypatch):
    """Tests don't need PG — ingest._upsert_jobs skips when RELAY_PG_DSN is unset."""
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


def _install_mock_transport_for_module(module_path: str, handler):
    fake_transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def patched_client(*a, **kw):
        kw["transport"] = fake_transport
        return real_async_client(*a, **kw)

    return patch(f"{module_path}.httpx.AsyncClient", side_effect=patched_client)


# ─────────────────────────────────────────────────────────────────────
# Greenhouse fetcher
# ─────────────────────────────────────────────────────────────────────


async def test_greenhouse_fetch_normalises_jobs():
    sample = {
        "jobs": [
            {
                "id": 12345,
                "title": "Staff Software Engineer, Payments",
                "absolute_url": "https://boards.greenhouse.io/stripe/jobs/12345",
                "updated_at": "2026-06-20T10:00:00Z",
                "content": "<p>You will build &amp; ship payments infrastructure.</p>",
            },
            {
                "id": 67890,
                "title": "Senior PM",
                "absolute_url": "https://boards.greenhouse.io/stripe/jobs/67890",
                "updated_at": "2026-06-19T08:30:00+00:00",
                "content": "<p>PM for the Connect product line.</p>",
            },
        ]
    }

    def handler(req: httpx.Request) -> httpx.Response:
        assert "stripe" in str(req.url)
        assert req.url.params["content"] == "true"
        return httpx.Response(200, json=sample)

    with _install_mock_transport_for_module("agents.jobs.sources", handler):
        rows = await fetch_greenhouse("stripe")

    assert len(rows) == 2
    first = rows[0]
    assert first["source"] == "greenhouse"
    assert first["external_id"] == "12345"
    assert first["company"] == "Stripe"
    assert first["role_title"] == "Staff Software Engineer, Payments"
    assert first["url"].endswith("/jobs/12345")
    assert isinstance(first["posted_date"], datetime)
    assert first["posted_date"].tzinfo is not None
    # HTML decoded + tags stripped
    assert "&amp;" not in first["jd_text"]
    assert "build & ship" in first["jd_text"]


async def test_greenhouse_fetch_http_error_returns_empty():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="boom")

    with _install_mock_transport_for_module("agents.jobs.sources", handler):
        rows = await fetch_greenhouse("stripe")

    assert rows == []


async def test_greenhouse_fetch_skips_rows_without_title_or_id():
    sample = {
        "jobs": [
            {"id": 1, "title": "", "absolute_url": "x", "content": "x"},
            {"title": "No id"},
            {"id": 2, "title": "Real", "absolute_url": "u", "content": "ok"},
        ]
    }

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=sample)

    with _install_mock_transport_for_module("agents.jobs.sources", handler):
        rows = await fetch_greenhouse("anywhere")

    assert len(rows) == 1
    assert rows[0]["external_id"] == "2"


# ─────────────────────────────────────────────────────────────────────
# Lever fetcher
# ─────────────────────────────────────────────────────────────────────


async def test_lever_fetch_normalises_jobs():
    sample = [
        {
            "id": "abc-123",
            "text": "Senior Backend Engineer",
            "hostedUrl": "https://jobs.lever.co/linear/abc-123",
            "createdAt": 1718841600000,  # 2024-06-20 00:00 UTC
            "descriptionPlain": "Build the issue tracker of the future.",
            "lists": [
                {
                    "text": "What you'll do",
                    "content": "<li>Own the API.</li><li>Mentor juniors.</li>",
                },
            ],
        },
    ]

    def handler(req: httpx.Request) -> httpx.Response:
        assert "linear" in str(req.url)
        return httpx.Response(200, json=sample)

    with _install_mock_transport_for_module("agents.jobs.sources", handler):
        rows = await fetch_lever("linear")

    assert len(rows) == 1
    r = rows[0]
    assert r["source"] == "lever"
    assert r["external_id"] == "abc-123"
    assert r["company"] == "Linear"
    assert r["url"].endswith("abc-123")
    assert "issue tracker" in r["jd_text"]
    assert "Own the API" in r["jd_text"]
    assert r["posted_date"] is not None


async def test_lever_fetch_handles_non_list_response():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    with _install_mock_transport_for_module("agents.jobs.sources", handler):
        rows = await fetch_lever("nonprofit")

    assert rows == []


# ─────────────────────────────────────────────────────────────────────
# Ashby fetcher
# ─────────────────────────────────────────────────────────────────────


async def test_ashby_fetch_normalises_jobs():
    sample = {
        "jobs": [
            {
                "id": "uuid-1",
                "title": "Founding Engineer",
                "jobUrl": "https://jobs.ashbyhq.com/posthog/uuid-1",
                "publishedAt": "2026-06-15T14:00:00.000Z",
                "descriptionHtml": "<p>Build product analytics at scale.</p>",
            }
        ]
    }

    def handler(req: httpx.Request) -> httpx.Response:
        assert "posthog" in str(req.url)
        return httpx.Response(200, json=sample)

    with _install_mock_transport_for_module("agents.jobs.sources", handler):
        rows = await fetch_ashby("posthog")

    assert len(rows) == 1
    r = rows[0]
    assert r["source"] == "ashby"
    assert r["external_id"] == "uuid-1"
    assert r["company"] == "Posthog"
    assert "product analytics" in r["jd_text"]


# ─────────────────────────────────────────────────────────────────────
# ingest_all orchestration
# ─────────────────────────────────────────────────────────────────────


async def test_ingest_all_continues_when_one_board_crashes():
    """A single bad board should NOT kill the rest."""
    boards = [
        ingest.Board("greenhouse", "good-co", "Good Co"),
        ingest.Board("greenhouse", "bad-co", "Bad Co"),
    ]

    def handler(req: httpx.Request) -> httpx.Response:
        if "bad-co" in str(req.url):
            return httpx.Response(500, text="upstream broken")
        return httpx.Response(
            200,
            json={
                "jobs": [
                    {
                        "id": 1,
                        "title": "Eng",
                        "absolute_url": "u",
                        "content": "ok",
                    }
                ]
            },
        )

    with _install_mock_transport_for_module("agents.jobs.sources", handler):
        results = await ingest.ingest_all(boards)

    assert len(results) == 2
    assert results[0]["fetched"] == 1
    assert results[0]["upserted"] == 0  # no PG
    assert results[1]["fetched"] == 0


async def test_default_boards_covers_all_three_sources():
    sources = {b.source for b in ingest.DEFAULT_BOARDS}
    assert sources == {"greenhouse", "lever", "ashby"}


async def test_label_override_replaces_company_name():
    """Board.label overrides the auto-derived company name."""
    board = ingest.Board("greenhouse", "company-x", "Custom Display Name")

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "jobs": [
                    {"id": 1, "title": "Role", "absolute_url": "u", "content": "x"}
                ]
            },
        )

    captured_rows: list[dict] = []

    async def fake_upsert(rows):
        captured_rows.extend(rows)
        return len(rows)

    async def fake_deactivate(**_kw):
        return 0

    with _install_mock_transport_for_module(
        "agents.jobs.sources", handler
    ), patch.object(ingest, "_upsert_jobs", new=fake_upsert), patch.object(
        ingest, "_deactivate_missing", new=fake_deactivate
    ):
        result = await ingest.ingest_board(board)

    assert result["upserted"] == 1
    assert captured_rows[0]["company"] == "Custom Display Name"
