"""Unit tests for the relay-dock MCP adapter layer.

Verifies the contract every adapter must hold:
  - Each adapter binds + tears down the dock contextvars cleanly so the
    underlying LangGraph tool sees the right user_id.
  - The TOOL_CATALOG matches what server.py imports, with valid JSON
    Schemas for every entry.
  - find_tool() returns descriptors by name and None on miss.
  - Async-on-sync adapters (propose_plan) still return dicts.

We do NOT exercise the MCP stdio transport here — that's
``test_mcp_dock_server.py``'s job (when the mcp SDK is available). These
tests are unit-level and run without the experimental extra.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agents.coordinator import dock_tools
from agents.mcp_dock import tools


@pytest.fixture(autouse=True)
def _clear_user_ctx():
    """Belt + braces: ensure no test leaves the contextvar bound."""
    assert dock_tools._USER_CTX.get() is None
    yield
    assert dock_tools._USER_CTX.get() is None


@pytest.mark.asyncio
async def test_propose_plan_adapter():
    uid = str(uuid4())
    out = await tools.propose_plan(
        user_id=uid,
        user_goal="Tailor for Stripe",
        steps=[
            {
                "step": "tailor",
                "agent": "resume_agent",
                "label": "Customise",
                "requires_review": True,
            }
        ],
    )
    assert out["status"] == "ok"
    assert out["plan"][0]["agent"] == "resume_agent"
    assert out["plan"][0]["requires_review"] is True


@pytest.mark.asyncio
async def test_recall_user_memory_adapter_degrades_on_pg_failure():
    uid = str(uuid4())
    with patch(
        "agents.tools.auto.pg_query",
        new=AsyncMock(side_effect=RuntimeError("PG offline")),
    ):
        out = await tools.recall_user_memory(user_id=uid, query="preferences")
    assert out["status"] == "unavailable"
    assert out["items"] == []


@pytest.mark.asyncio
async def test_recall_past_applications_adapter_returns_rows():
    uid = str(uuid4())
    rows = [
        {
            "company": "Stripe",
            "role_title": "Staff Eng",
            "status": "interview",
            "updated_at": "2026-06-20",
        }
    ]
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=rows)):
        out = await tools.recall_past_applications(user_id=uid, limit=5)
    assert out["status"] == "ok"
    assert len(out["items"]) == 1


@pytest.mark.asyncio
async def test_list_my_applications_adapter():
    uid = str(uuid4())
    rows = [
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "company": "Linear",
            "role_title": "PM",
            "status": "offer",
        }
    ]
    with patch(
        "agents.tools.applications.list_applications",
        new=AsyncMock(return_value=rows),
    ):
        out = await tools.list_my_applications(user_id=uid, limit=25)
    assert out["status"] == "ok"
    assert out["count"] == 1
    assert out["items"][0]["company"] == "Linear"


@pytest.mark.asyncio
async def test_tailor_resume_adapter_needs_args():
    uid = str(uuid4())
    job_id = str(uuid4())
    out = await tools.tailor_resume(user_id=uid, job_id=job_id, notes="emphasis on payments")
    assert out["status"] == "needs_args"
    assert out["agent"] == "resume_agent"
    assert out["args"]["job_id"] == job_id
    assert out["args"]["notes"] == "emphasis on payments"
    assert out["args"]["user_id"] == uid


@pytest.mark.asyncio
async def test_find_jobs_adapter_empty(monkeypatch):
    """P2-3: find_jobs now hits the jobs table. Without RELAY_PG_DSN the
    backing pg_query returns [], so the MCP adapter surfaces status=empty."""
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    uid = str(uuid4())
    out = await tools.find_jobs(user_id=uid, role="staff engineer", remote_only=True, limit=999)
    assert out["status"] == "empty"
    assert out["items"] == []


def test_tool_catalog_shape():
    """Every catalog entry must have name/func/description/input_schema."""
    for spec in tools.TOOL_CATALOG:
        for key in ("name", "func", "description", "input_schema"):
            assert key in spec, f"missing {key} in {spec.get('name')!r}"
        schema = spec["input_schema"]
        assert schema["type"] == "object"
        assert "properties" in schema
        # Every tool must require user_id (the MCP-level scoping arg).
        assert "user_id" in schema.get("required", []), f"{spec['name']} doesn't require user_id"


def test_find_tool_round_trip():
    assert tools.find_tool("propose_plan")["name"] == "propose_plan"
    assert tools.find_tool("nope") is None


def test_with_user_rejects_invalid_uuid():
    """_with_user must validate the UUID — passing garbage should raise."""
    with pytest.raises(ValueError):
        tools._with_user("not-a-uuid")


@pytest.mark.asyncio
async def test_context_isolation_after_adapter_call():
    """Adapter must reset the contextvar even on tool failure."""
    uid = str(uuid4())
    with patch(
        "agents.tools.auto.pg_query",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        out = await tools.recall_user_memory(user_id=uid, query="x")
    assert out["status"] == "unavailable"
    # autouse fixture asserts context cleanup on teardown.
