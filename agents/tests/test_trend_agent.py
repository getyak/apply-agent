"""Unit tests for TrendAgent parsing + aggregation + insight logic.

Hermetic: no network, no LLM, no PG. Board fetch is driven off a synthetic
in-memory Greenhouse fixture written to a temp RELAY_TREND_FIXTURE_DIR; the LLM
parse is faked with ``patch.object(trend_agent, "pick_model", ...)``. These
cover the pure logic (HTML strip, normalisation, aggregation, the "learn X →
+Y roles" insight builder). The real network + real LLM run lives in
``test_chain7_trend_e2e_score.py``.
"""

from __future__ import annotations

import json
from unittest.mock import patch
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage

from agents.nodes import trend_agent as ta

# ── Synthetic board fixture ─────────────────────────────────────────────────


def _fixture_board(company: str, titles: list[str]) -> dict:
    return {
        "jobs": [
            {
                "id": 1000 + i,
                "title": t,
                "content": f"<p>We are hiring a {t}. You will build great things.</p>",
                "location": {"name": "Remote"},
                "updated_at": "2020-01-01T00:00:00-05:00",
            }
            for i, t in enumerate(titles)
        ]
    }


@pytest.fixture
def fixture_dir(tmp_path, monkeypatch):
    (tmp_path / "greenhouse_acme.json").write_text(
        json.dumps(_fixture_board("acme", ["Backend Engineer", "Data Scientist"])),
        encoding="utf-8",
    )
    (tmp_path / "greenhouse_globex.json").write_text(
        json.dumps(_fixture_board("globex", ["Backend Engineer", "Product Manager"])),
        encoding="utf-8",
    )
    monkeypatch.setenv(ta.FIXTURE_DIR_ENV, str(tmp_path))
    # No PG, no LLM by default — each test opts in.
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    yield tmp_path


# ── Pure helpers ────────────────────────────────────────────────────────────


def test_strip_html_unescapes_and_strips_tags():
    out = ta._strip_html("&lt;p&gt;Hello &amp; welcome&lt;/p&gt;<b>bold</b>")
    assert "<" not in out and ">" not in out
    assert "Hello & welcome" in out
    assert "bold" in out


def test_role_from_title_drops_seniority_and_team():
    assert ta._role_from_title("Senior Staff Backend Engineer, Payments") == "Backend Engineer"
    assert ta._role_from_title("Principal Data Scientist (ML)") == "Data Scientist"
    assert ta._role_from_title("") == "Unspecified"


def test_sanitize_salary_rejects_out_of_range():
    assert ta._sanitize_salary(150000) == 150000
    assert ta._sanitize_salary(-5) is None
    assert ta._sanitize_salary(10**10) is None
    assert ta._sanitize_salary("nope") is None
    assert ta._sanitize_salary(None) is None


def test_dedup_skills_case_insensitive_first_seen_wins():
    assert ta._dedup_skills(["TypeScript", "typescript", "Go"]) == ["TypeScript", "Go"]


def test_normalize_parsed_swaps_reversed_salary_and_clamps_enums():
    raw = {
        "skills": ["Go", " ", "go"],
        "role": "Backend Engineer",
        "level": "wizard",  # not in enum → unspecified
        "remote": "REMOTE",  # case-normalised
        "salary_min": 200000,
        "salary_max": 100000,  # reversed
    }
    job = ta._RawJob("acme", "1", "Backend Engineer", "jd", "Remote", False)
    p = ta._normalize_parsed(raw, job)
    assert p.skills == ["Go"]
    assert p.level == "unspecified"
    assert p.remote == "remote"
    assert (p.salary_min, p.salary_max) == (100000, 200000)


def test_skills_from_resume_handles_dict_and_string_blocks():
    content = {
        "skills": [
            {"name": "Languages", "keywords": ["Python", "TypeScript"]},
            {"name": "Go"},
            "Kubernetes",
        ]
    }
    got = ta._skills_from_resume(content)
    assert set(got) >= {"Languages", "Python", "TypeScript", "Go", "Kubernetes"}
    # tolerates JSON string too
    assert "Go" in ta._skills_from_resume(json.dumps(content))


# ── Aggregation ─────────────────────────────────────────────────────────────


def test_aggregate_ranks_skills_desc_and_computes_remote_ratio():
    parsed = [
        ta._ParsedJob(
            "acme", "Backend Engineer", ["Go", "PostgreSQL"], "senior", "remote", 100000, 150000
        ),
        ta._ParsedJob(
            "acme", "Backend Engineer", ["Go", "Kubernetes"], "mid", "hybrid", None, None
        ),
        ta._ParsedJob("globex", "Data Scientist", ["Python"], "senior", "onsite", None, None),
    ]
    raw = [ta._RawJob("acme", "1", "x", "jd", "Remote", True)] * 3
    snap = ta._aggregate(parsed, raw, sources=["acme", "globex"])
    assert snap.total_jobs == 3
    # Go appears twice → top skill
    assert snap.skills[0]["skill"] == "Go"
    assert snap.skills[0]["count"] == 2
    counts = [s["count"] for s in snap.skills]
    assert counts == sorted(counts, reverse=True)
    # 2 of 3 are remote/hybrid
    assert snap.remote_ratio == round(2 / 3, 3)
    assert snap.salary_stats["median"] == 125000
    roles = {r["role"] for r in snap.top_roles}
    assert roles == {"Backend Engineer", "Data Scientist"}


# ── Insights: the "learn X → +Y roles" hook ─────────────────────────────────


def test_build_insights_skips_skills_user_has_and_phrases_hook():
    parsed = [
        ta._ParsedJob("acme", "Backend Engineer", ["Go", "Rust"], "senior", "remote", None, None),
        ta._ParsedJob(
            "acme", "Backend Engineer", ["Rust", "Kubernetes"], "mid", "remote", None, None
        ),
        ta._ParsedJob("globex", "Backend Engineer", ["Rust"], "mid", "remote", None, None),
    ]
    raw = [ta._RawJob("acme", "1", "x", "jd", "", False)] * 3
    snap = ta._aggregate(parsed, raw, sources=["acme"])
    # User already knows Go → it must NOT appear as an insight.
    insights = ta._build_insights(parsed, snap, user_skills=["Go"])
    skills_flagged = {i["skill"] for i in insights}
    assert "Go" not in skills_flagged
    # Rust is the top gap: appears in 3 jobs → "+3 roles"
    rust = next(i for i in insights if i["skill"] == "Rust")
    assert rust["unlock_roles"] == 3
    assert rust["message"] == "if you learn Rust, +3 roles"


# ── End-to-end through today_snapshot (fixture board + fake LLM, no persist) ──


class _FakeSkillModel:
    """Returns a deterministic parse keyed on the JD title so different roles
    yield different skills, exercising the aggregation across two boards."""

    async def ainvoke(self, messages, **_kw):
        text = str(messages[-1].content)
        if "Data Scientist" in text:
            payload = {
                "skills": ["Python", "SQL"],
                "role": "Data Scientist",
                "level": "senior",
                "remote": "remote",
                "salary_min": None,
                "salary_max": None,
            }
        elif "Product Manager" in text:
            payload = {
                "skills": ["Roadmapping"],
                "role": "Product Manager",
                "level": "mid",
                "remote": "hybrid",
                "salary_min": None,
                "salary_max": None,
            }
        else:
            payload = {
                "skills": ["Go", "PostgreSQL"],
                "role": "Backend Engineer",
                "level": "senior",
                "remote": "remote",
                "salary_min": 120000,
                "salary_max": 180000,
            }
        return AIMessage(content=json.dumps(payload))


@pytest.mark.asyncio
async def test_today_snapshot_end_to_end_fixture(fixture_dir):
    with patch.object(ta, "pick_model", return_value=_FakeSkillModel()):
        snap = await ta.today_snapshot(
            uuid4(),
            boards=("acme", "globex"),
            max_jobs=10,
            persist=False,
            user_skills=["Go"],  # so Go is filtered from insights
        )

    assert snap.total_jobs == 4  # 2 boards × 2 jobs
    assert set(snap.sources) == {"acme", "globex"}
    # Go appears in both Backend Engineer jobs → top skill by count.
    assert snap.skills[0]["skill"] == "Go"
    assert snap.skills[0]["count"] == 2
    # User has Go → the lead insight must be a skill they lack.
    assert snap.insights
    assert all(i["skill"].lower() != "go" for i in snap.insights)
    assert snap.insights[0]["message"].startswith("if you learn ")


@pytest.mark.asyncio
async def test_today_snapshot_no_llm_key_still_aggregates_roles(fixture_dir):
    """Without OPENROUTER_API_KEY the fallback parser derives role families
    from titles, so aggregation is still non-empty (graceful degradation)."""
    snap = await ta.today_snapshot(
        uuid4(), boards=("acme", "globex"), max_jobs=10, persist=False, user_skills=[]
    )
    assert snap.total_jobs == 4
    # No LLM → no skills, but roles come from titles.
    roles = {r["role"] for r in snap.top_roles}
    assert "Backend Engineer" in roles


@pytest.mark.asyncio
async def test_today_snapshot_raises_when_all_boards_empty(fixture_dir):
    with pytest.raises(ta.TrendFetchError):
        await ta.today_snapshot(
            uuid4(), boards=("does_not_exist",), max_jobs=10, persist=False, user_skills=[]
        )
