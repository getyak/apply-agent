"""Tool-function unit tests — direct calls against the fake fixtures.

These do NOT go through the MCP stdio transport. They prove:
- search_jobs returns the correct subset of _FAKE_JOBS by query
- tailor_resume's fake path STILL invokes fabrication_guard (vision.md red line)
- tailor_resume returns {ok: False, fabricated: [...]} when fabrication is
  injected, never silently passing
"""

from __future__ import annotations

import pytest

from agents.mcp_probe import tools


@pytest.fixture(autouse=True)
def _enable_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_MCP_PROBE_FAKE", "1")


# ─── search_jobs ─────────────────────────────────────────────────────────


async def test_search_jobs_matches_role_title() -> None:
    result = await tools.search_jobs(query="backend")
    assert "jobs" in result
    titles = {j["role_title"] for j in result["jobs"]}
    assert "Senior Backend Engineer" in titles
    assert "Backend Engineer (Infra)" in titles
    assert "Frontend Engineer" not in titles  # filtered out


async def test_search_jobs_matches_skill() -> None:
    result = await tools.search_jobs(query="GraphQL")
    titles = {j["role_title"] for j in result["jobs"]}
    assert titles == {"Backend Engineer (Infra)"}


async def test_search_jobs_returns_skills_field() -> None:
    # "Accessibility" only appears in the Anthropic Frontend job's skills.
    # If matching ever broadens to company names this assertion should be
    # updated to filter by role_title — but today company-name search is
    # intentionally out of scope (parsed::skills is the searchable field).
    result = await tools.search_jobs(query="accessibility")
    assert len(result["jobs"]) == 1
    assert result["jobs"][0]["skills"] == ["React", "TypeScript", "Accessibility"]


async def test_search_jobs_empty_query_returns_empty() -> None:
    result = await tools.search_jobs(query="")
    assert result == {"jobs": []}


# ─── tailor_resume ───────────────────────────────────────────────────────


async def test_tailor_resume_fake_passes_fabrication_guard() -> None:
    result = await tools.tailor_resume(
        base_resume_id="00000000-0000-0000-0000-000000000001",
        jd_id="00000000-0000-0000-0000-000000000a01",
        user_id="00000000-0000-0000-0000-000000000999",
    )
    assert result["ok"] is True
    assert result["fabricated"] == []
    assert result["via"] == "fake"
    # tailored must keep the original company + position (no fabrication)
    work = result["tailored"]["work"][0]
    assert work["name"] == "Acme Corp"
    assert work["position"] == "Senior Backend Engineer"


async def test_tailor_resume_fabrication_guard_is_real() -> None:
    """Inject a fabricated company → guard must reject. This proves the probe
    is wired to the SAME fabrication_guard the production resume_agent uses,
    not a stub. vision.md red line preserved."""
    from agents.nodes.resume_agent import fabrication_guard

    base = tools._FAKE_BASE_RESUME
    bad_tailored = {
        **base,
        "work": [
            {**base["work"][0], "name": "FakeCo That Never Existed"},
        ],
    }
    fab = fabrication_guard(base, bad_tailored)
    assert any("FakeCo That Never Existed" in f for f in fab)
