"""Unit tests for agents/nodes/jobmatch_agent.py — JD ingestion pipeline.

What's covered (hermetic — no network, no LLM, no PG):
- ATS detection from URL pattern (greenhouse / lever / ashby / other)
- Fixture loading via $RELAY_JD_FIXTURE_DIR (eval-gate path)
- Shape parsers for Greenhouse JSON, Lever JSON, Ashby HTML
- Top-level parse_jd_from_url contract with persist=False + LLM stubbed
- _normalize_parsed defends against malformed LLM output

What is NOT covered here (lands in T4 integration / smoke tests):
- Live OpenRouter calls
- Real network fetch of ATS pages
- Actual UPSERT into jobs table (smoke run with RELAY_PG_DSN set)
"""

from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import pytest

from agents.nodes import jobmatch_agent as jm

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "jd"


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    """Keep tests off the network and off any developer's PG."""
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    monkeypatch.setenv("RELAY_JD_FIXTURE_DIR", str(FIXTURE_DIR))


# ─── ATS detection ─────────────────────────────────────────────────────


def test_detect_ats_greenhouse():
    source, ext_id = jm._detect_ats("https://boards.greenhouse.io/synthetic/jobs/4071234")
    assert source == "greenhouse"
    assert ext_id == "4071234"


def test_detect_ats_lever():
    source, ext_id = jm._detect_ats("https://jobs.lever.co/synthetic/abc-123")
    assert source == "lever"
    assert ext_id == "abc-123"


def test_detect_ats_ashby():
    source, ext_id = jm._detect_ats("https://jobs.ashbyhq.com/synthetic/xyz-789")
    assert source == "ashby"
    assert ext_id == "xyz-789"


def test_detect_ats_unknown_falls_back_to_other():
    source, ext_id = jm._detect_ats("https://example.com/careers/some-role")
    assert source == "other"
    assert ext_id is None


def test_detect_ats_handles_url_without_external_id():
    source, ext_id = jm._detect_ats("https://boards.greenhouse.io/synthetic")
    assert source == "greenhouse"
    assert ext_id is None


# ─── shape parsers (no LLM, no network) ────────────────────────────────


def test_shape_greenhouse_from_fixture():
    body = (FIXTURE_DIR / "greenhouse_4071234.json").read_bytes()
    raw = jm._parse_fixture(
        body, "greenhouse", "https://boards.greenhouse.io/synthetic/jobs/4071234"
    )
    assert raw.company == "Synthetic Labs"
    assert "Senior Software Engineer" in raw.role_title
    assert "Platform team" in raw.jd_text
    # HTML tags should be stripped.
    assert "<p>" not in raw.jd_text
    assert "<ul>" not in raw.jd_text


def test_shape_lever_from_fixture():
    body = (FIXTURE_DIR / "lever_abc-123.json").read_bytes()
    raw = jm._parse_fixture(body, "lever", "https://jobs.lever.co/synthetic/abc-123")
    assert raw.role_title == "Staff Backend Engineer"
    assert raw.company == "Synthetic Robotics"
    # lever_abc-123.json's `lists` items must be appended to jd_text.
    assert "Responsibilities" in raw.jd_text or "Requirements" in raw.jd_text


def test_shape_html_ashby_from_fixture():
    body = (FIXTURE_DIR / "ashby_xyz-789.html").read_bytes()
    raw = jm._parse_fixture(body, "ashby", "https://jobs.ashbyhq.com/synthetic/xyz-789")
    assert "Frontend Engineer" in raw.role_title
    # Company derived from URL path when HTML has no obvious company field.
    assert raw.company == "Synthetic"
    assert "React" in raw.jd_text
    # <main> content extracted; <header>/<footer> not included.
    assert "©" not in raw.jd_text


# ─── _normalize_parsed defends against malformed LLM output ────────────


def test_normalize_parsed_fills_missing_keys_with_defaults():
    out = jm._normalize_parsed({"skills": ["TypeScript", "Go"]})
    # All required keys must be present.
    for key in (
        "skills",
        "level",
        "salary_min",
        "salary_max",
        "salary_currency",
        "locations",
        "remote",
        "must_haves",
        "nice_to_haves",
        "responsibilities",
        "tech_stack",
    ):
        assert key in out
    assert out["skills"] == ["TypeScript", "Go"]
    assert out["level"] == "unspecified"
    assert out["locations"] == []


def test_normalize_parsed_coerces_bad_types():
    out = jm._normalize_parsed({"skills": "not a list", "level": "senior"})
    assert out["skills"] == []  # bad type → default
    assert out["level"] == "senior"


def test_normalize_parsed_rejects_non_dict():
    out = jm._normalize_parsed("garbage")  # type: ignore[arg-type]
    assert out == jm._empty_parsed()


# ─── top-level parse_jd_from_url with LLM stubbed ──────────────────────


async def test_parse_jd_from_url_greenhouse_end_to_end(monkeypatch):
    """End-to-end (sans LLM, sans PG): URL → ATS → fixture → shape → return."""

    async def stub_llm(jd_text, company, role_title, source):
        return {"skills": ["TypeScript", "PostgreSQL", "AWS"], "level": "senior"}

    monkeypatch.setattr(jm, "_llm_parse_jd", stub_llm)

    result = await jm.parse_jd_from_url(
        "https://boards.greenhouse.io/synthetic/jobs/4071234",
        user_id=uuid4(),
        persist=False,
    )

    assert result.source == "greenhouse"
    assert result.external_id == "4071234"
    assert result.company == "Synthetic Labs"
    assert "Senior Software Engineer" in result.role_title
    # LLM output normalized.
    assert "TypeScript" in result.parsed["skills"]
    assert result.parsed["level"] == "senior"
    # persist=False → no PG row, no job_id.
    assert result.job_id is None


async def test_parse_jd_from_url_ashby_html_fixture(monkeypatch):
    async def stub_llm(jd_text, company, role_title, source):
        return {"skills": ["React", "TypeScript"], "level": "mid"}

    monkeypatch.setattr(jm, "_llm_parse_jd", stub_llm)

    result = await jm.parse_jd_from_url(
        "https://jobs.ashbyhq.com/synthetic/xyz-789",
        user_id=uuid4(),
        persist=False,
    )
    assert result.source == "ashby"
    assert "Frontend Engineer" in result.role_title
    assert "React" in result.parsed["skills"]


async def test_parse_jd_from_url_persist_noop_without_dsn(monkeypatch):
    """persist=True + no RELAY_PG_DSN → still returns successfully (job_id=None)."""

    async def stub_llm(jd_text, company, role_title, source):
        return {"skills": []}

    monkeypatch.setattr(jm, "_llm_parse_jd", stub_llm)
    assert "RELAY_PG_DSN" not in os.environ

    result = await jm.parse_jd_from_url(
        "https://jobs.lever.co/synthetic/abc-123",
        user_id=uuid4(),
        persist=True,
    )
    # No DSN → upsert skipped, job_id is None but parsed payload still arrives.
    assert result.job_id is None
    assert result.source == "lever"
    assert result.role_title == "Staff Backend Engineer"


# ─── _strip_html sanity ────────────────────────────────────────────────


def test_strip_html_collapses_tags_preserves_newlines():
    html = "<p>Line 1</p><p>Line 2</p>\n<ul><li>A</li><li>B</li></ul>"
    out = jm._strip_html(html)
    assert "<" not in out and ">" not in out
    assert "Line 1" in out and "Line 2" in out
    assert "A" in out and "B" in out
