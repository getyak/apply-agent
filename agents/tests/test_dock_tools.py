"""Unit tests for the Dock agent's tool registry.

Covers each tool's contract end-to-end without hitting the LLM:
  - propose_plan validates + caps fields
  - recall_* tools degrade gracefully when PG is unavailable
  - tailor_resume / find_jobs / draft_cover_letter return needs_args envelopes
  - list_my_applications wraps the applications tool
  - context guard refuses tool calls without a bound user_id
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agents.coordinator import dock_tools


@pytest.fixture
def bound_user():
    """Fixture that binds a user into dock contextvars for the test scope."""
    user_id = uuid4()
    tokens = dock_tools.set_dock_context(
        user_id=user_id, thread_id=f"ask_vantage:{user_id}", surface="dock"
    )
    try:
        yield user_id
    finally:
        dock_tools.reset_dock_context(tokens)


@pytest.mark.asyncio
async def test_propose_plan_returns_normalised_plan():
    out = dock_tools.propose_plan.invoke(
        {
            "user_goal": "Tailor my résumé for Stripe",
            "steps": [
                {
                    "step": "fetch_jd",
                    "agent": "jobmatch_agent",
                    "label": "Pull the Stripe JD",
                    "requires_review": False,
                },
                {
                    "step": "tailor",
                    "agent": "resume_agent",
                    "label": "Customise master résumé",
                    "requires_review": True,
                },
            ],
        }
    )
    assert out["status"] == "ok"
    assert out["plan"][0]["agent"] == "jobmatch_agent"
    assert out["plan"][1]["requires_review"] is True
    assert "plan_id" in out


@pytest.mark.asyncio
async def test_propose_plan_caps_string_lengths():
    huge_label = "x" * 500
    out = dock_tools.propose_plan.invoke(
        {
            "user_goal": "g" * 1000,
            "steps": [{"step": "y" * 200, "agent": "resume_agent", "label": huge_label}],
        }
    )
    assert len(out["user_goal"]) <= 200
    assert len(out["plan"][0]["step"]) <= 80
    assert len(out["plan"][0]["label"]) <= 200


@pytest.mark.asyncio
async def test_propose_plan_drops_non_dict_steps():
    """The body-level guard drops bad entries. pydantic catches them earlier
    at LangChain tool layer, so we exercise the underlying function directly
    to confirm the post-validation guard is also defensive."""
    # Access the wrapped function (LangChain @tool exposes .func)
    fn = dock_tools.propose_plan.func
    out = fn(
        user_goal="ok",
        steps=[
            "not a dict",
            {"step": "good", "agent": "resume_agent", "label": "ok"},
        ],
    )
    assert len(out["plan"]) == 1
    assert out["plan"][0]["step"] == "good"


@pytest.mark.asyncio
async def test_tool_without_user_context_raises():
    with pytest.raises(RuntimeError, match="user context"):
        await dock_tools.tailor_resume.ainvoke({"job_id": str(uuid4())})


@pytest.mark.asyncio
async def test_tailor_resume_returns_needs_args(bound_user):
    job_id = str(uuid4())
    out = await dock_tools.tailor_resume.ainvoke({"job_id": job_id, "notes": "n"})
    assert out["status"] == "needs_args"
    assert out["agent"] == "resume_agent"
    assert out["action"] == "customize"
    assert "base_resume_content" in out["needs"]
    assert out["args"]["user_id"] == str(bound_user)


@pytest.mark.asyncio
async def test_find_jobs_empty_when_no_jobs(bound_user, monkeypatch):
    """P2-3: find_jobs now hits jobs table. Empty PG → status=empty."""
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    out = await dock_tools.find_jobs.ainvoke({"limit": 9999})
    # Without RELAY_PG_DSN pg_query returns [], so find_jobs returns "empty".
    assert out["status"] == "empty"
    assert out["items"] == []
    assert out["agent"] == "jobmatch_agent"


@pytest.mark.asyncio
async def test_draft_cover_letter_envelope(bound_user):
    out = await dock_tools.draft_cover_letter.ainvoke({"job_id": str(uuid4())})
    assert out["status"] == "needs_args"
    assert out["agent"] == "appprep_agent"
    assert out["args"]["tone"] == "professional"


@pytest.mark.asyncio
async def test_trends_today_stub(bound_user):
    out = await dock_tools.trends_today.ainvoke({})
    assert out["status"] == "not_implemented"
    assert out["agent"] == "trend_agent"


@pytest.mark.asyncio
async def test_recall_user_memory_degrades_on_pg_failure(bound_user):
    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=RuntimeError("PG down"))):
        out = await dock_tools.recall_user_memory.ainvoke({"query": "preferences"})
    assert out["status"] == "unavailable"
    assert out["items"] == []
    assert out["query"] == "preferences"


@pytest.mark.asyncio
async def test_recall_past_applications_returns_rows(bound_user):
    rows = [
        {
            "company": "Stripe",
            "role_title": "Staff Eng",
            "status": "interview",
            "updated_at": "2026-06-20",
        },
        {
            "company": "Linear",
            "role_title": "Senior PM",
            "status": "offer",
            "updated_at": "2026-06-19",
        },
    ]
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=rows)):
        out = await dock_tools.recall_past_applications.ainvoke({"limit": 5})
    assert out["status"] == "ok"
    assert len(out["items"]) == 2
    assert out["items"][0]["company"] == "Stripe"


@pytest.mark.asyncio
async def test_recall_weak_points_flattens_latest_session(bound_user):
    rows = [
        {
            "weak_points": [
                {"skill": "Owning impact", "confidence": 0.3},
                {"skill": "Naming trade-offs", "confidence": 0.4},
            ],
            "completed_at": "2026-06-20",
        }
    ]
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=rows)):
        out = await dock_tools.recall_weak_points.ainvoke({"limit": 3})
    assert out["status"] == "ok"
    assert len(out["items"]) == 2
    assert out["items"][0]["skill"] == "Owning impact"


@pytest.mark.asyncio
async def test_list_my_applications_wraps_helper(bound_user):
    rows = [
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "company": "Stripe",
            "role_title": "Staff Eng",
            "status": "interview",
        }
    ]
    with patch(
        "agents.tools.applications.list_applications",
        new=AsyncMock(return_value=rows),
    ):
        out = await dock_tools.list_my_applications.ainvoke({"limit": 10})
    assert out["status"] == "ok"
    assert out["count"] == 1
    assert out["items"][0]["company"] == "Stripe"


def test_dock_tools_registry_shape():
    """Smoke test: the public DOCK_TOOLS list must be non-empty and tool-shaped."""
    assert len(dock_tools.DOCK_TOOLS) >= 5
    names = {t.name for t in dock_tools.DOCK_TOOLS}
    required = {
        "propose_plan",
        "recall_user_memory",
        "recall_past_applications",
        "recall_weak_points",
        "list_my_applications",
        "read_resume",
        "tailor_resume",
        "find_jobs",
        "start_mock_interview",
        "draft_cover_letter",
        "build_resume_from_scratch",
        "trends_today",
    }
    assert required.issubset(names), f"missing tools: {required - names}"


# ─────────────────────────────────────────────────────────────────────
# D1a: read_resume tool
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_read_resume_returns_empty_when_no_resume(bound_user):
    """No résumé row → status: empty; the LLM must NOT pivot to find_jobs."""
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=[])):
        out = await dock_tools.read_resume.ainvoke({"scope": "summary"})
    assert out["status"] == "empty"
    assert out["agent"] == "resume_agent"
    assert out["action"] == "read"


@pytest.mark.asyncio
async def test_read_resume_returns_structured_content(bound_user):
    """Successful PG hit → structured content the LLM can narrate over."""
    row = {
        "id": uuid4(),
        "version": 3,
        "content": {
            "basics": {"name": "Test User", "label": "Senior Engineer"},
            "work": [
                {
                    "name": "Acme",
                    "position": "Eng",
                    "startDate": "2022-01",
                    "highlights": ["shipped feature X"],
                }
            ],
            "education": [{"institution": "Some Uni", "studyType": "BS"}],
            "skills": [{"name": "Python"}, {"name": "Go"}],
            "projects": [{"name": "Side Project"}],
        },
        "track": "base",
        "is_base": True,
        "created_at": None,
    }
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=[row])):
        out = await dock_tools.read_resume.ainvoke({"scope": "summary"})
    assert out["status"] == "ok"
    assert out["agent"] == "resume_agent"
    assert out["action"] == "read"
    assert out["track"] == "base"
    assert out["version"] == 3
    # Structured passthrough — the LLM uses these to compose a reply.
    assert out["content"]["basics"]["name"] == "Test User"
    assert out["content"]["work"][0]["name"] == "Acme"
    assert out["content"]["education"][0]["institution"] == "Some Uni"
    assert {"Python", "Go"}.issubset({s["name"] for s in out["content"]["skills"]})


@pytest.mark.asyncio
async def test_read_resume_unwraps_uploader_parsed_wrapper(bound_user):
    """Uploader stores ``{raw, parsed: <JSON Resume>, markdown}``; tool must unwrap."""
    row = {
        "id": uuid4(),
        "version": 1,
        "content": {
            "raw": "",
            "parsed": {
                "basics": {"name": "Wrapped"},
                "work": [{"name": "InnerCo", "position": "Eng"}],
                "skills": [{"name": "TypeScript"}],
            },
            "markdown": "# Wrapped\n_Eng_\n",
        },
        "track": "original",
        "is_base": True,
        "created_at": None,
    }
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=[row])):
        out = await dock_tools.read_resume.ainvoke({"scope": "summary"})
    assert out["status"] == "ok"
    assert out["content"]["basics"]["name"] == "Wrapped"
    assert out["content"]["work"][0]["name"] == "InnerCo"
    # markdown passthrough fall-back for the LLM if it wants to quote.
    assert "Wrapped" in (out["markdown"] or "")


@pytest.mark.asyncio
async def test_read_resume_summary_truncates_long_payloads(bound_user):
    """scope=summary caps work/skills counts so the SSE frame stays small."""
    big_work = [{"name": f"Co{i}", "position": "Eng"} for i in range(30)]
    big_skills = [{"name": f"skill_{i}"} for i in range(40)]
    row = {
        "id": uuid4(),
        "version": 1,
        "content": {"basics": {"name": "Bulky"}, "work": big_work, "skills": big_skills},
        "track": "base",
        "is_base": True,
        "created_at": None,
    }
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=[row])):
        out_summary = await dock_tools.read_resume.ainvoke({"scope": "summary"})
        out_full = await dock_tools.read_resume.ainvoke({"scope": "full"})
    assert len(out_summary["content"]["work"]) == 6
    assert len(out_summary["content"]["skills"]) == 20
    # full scope must NOT cap.
    assert len(out_full["content"]["work"]) == 30
    assert len(out_full["content"]["skills"]) == 40


@pytest.mark.asyncio
async def test_read_resume_invalid_scope_defaults_to_summary(bound_user):
    row = {
        "id": uuid4(),
        "version": 1,
        "content": {"basics": {"name": "X"}, "work": [{"name": f"C{i}"} for i in range(20)]},
        "track": "base",
        "is_base": True,
        "created_at": None,
    }
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=[row])):
        out = await dock_tools.read_resume.ainvoke({"scope": "garbage"})
    assert out["scope"] == "summary"
    assert len(out["content"]["work"]) == 6  # summary cap applied


@pytest.mark.asyncio
async def test_read_resume_degrades_on_pg_failure(bound_user):
    with patch(
        "agents.tools.auto.pg_query",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        out = await dock_tools.read_resume.ainvoke({"scope": "summary"})
    assert out["status"] == "error"
    # No content payload on the error path.
    assert "content" not in out


def test_dock_context_isolation():
    """contextvars must isolate per-task — a token reset returns to None."""
    assert dock_tools._USER_CTX.get() is None
    u = uuid4()
    tokens = dock_tools.set_dock_context(user_id=u, thread_id=f"ask_vantage:{u}", surface="dock")
    assert dock_tools._USER_CTX.get() == u
    dock_tools.reset_dock_context(tokens)
    assert dock_tools._USER_CTX.get() is None


# ───────────────────────────────────────────────────────────────────────
# Step 1 — narrate() tool
# ───────────────────────────────────────────────────────────────────────


def test_narrate_returns_trimmed_thought():
    out = dock_tools.narrate.invoke(
        {"thought": "  Sweeping the master résumé for payments wins.  "}
    )
    assert out["status"] == "ok"
    assert out["narration"] == "Sweeping the master résumé for payments wins."


def test_narrate_caps_long_thought_at_160_chars():
    long = "x" * 500
    out = dock_tools.narrate.invoke({"thought": long})
    assert out["status"] == "ok"
    assert len(out["narration"]) == 160


def test_narrate_drops_whitespace_only():
    out = dock_tools.narrate.invoke({"thought": "   \n\t  "})
    assert out["status"] == "ok"
    assert out["narration"] == ""


def test_narrate_drops_empty_string():
    out = dock_tools.narrate.invoke({"thought": ""})
    assert out["status"] == "ok"
    assert out["narration"] == ""


def test_narrate_listed_in_registry_after_propose_plan():
    """narrate must come right after propose_plan so the LLM sees them as a pair."""
    names = [t.name for t in dock_tools.DOCK_TOOLS]
    plan_idx = names.index("propose_plan")
    narr_idx = names.index("narrate")
    assert narr_idx == plan_idx + 1
