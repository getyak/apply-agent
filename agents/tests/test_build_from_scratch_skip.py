"""Unit tests for the P2-1 build_from_scratch upgrades.

Locks down:
  - ask_target_role / ask_recent_role skip when state already has the value
  - prefill_from_profile reads users.preferences + most recent résumé
  - prefill returns empty dict when nothing useful is found
  - The graph wires prefill as entry point + adds clear nodes + refine edges
  - _route_after_review routes to clear node when edit_step is present
  - _route_after_review returns END when edit_step missing / unrecognised
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agents.coordinator import workflows


@pytest.fixture(autouse=True)
def _no_pg(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


# ─────────────────────────────────────────────────────────────────────
# Skip-when-known
# ─────────────────────────────────────────────────────────────────────


async def test_ask_target_role_skips_when_already_set():
    state = {"user_id": uuid4(), "target_role": "Senior PM"}
    out = await workflows.ask_target_role(state)
    assert out == {}  # didn't call interrupt


async def test_ask_recent_role_skips_when_already_set():
    state = {"user_id": uuid4(), "recent_role": "Software Eng"}
    out = await workflows.ask_recent_role(state)
    assert out == {}


# ─────────────────────────────────────────────────────────────────────
# prefill_from_profile
# ─────────────────────────────────────────────────────────────────────


async def test_prefill_reads_preferences_and_resume():
    """Found in users.preferences + resumes.content → fields filled."""

    async def fake_pg(sql, params=()):
        if "FROM users" in sql:
            return [
                {
                    "preferences": {
                        "target_roles": [
                            "Staff Backend Engineer",
                            "Engineering Manager",
                        ]
                    }
                }
            ]
        if "FROM resumes" in sql:
            return [
                {
                    "content": {
                        "work": [
                            {"position": "Senior Software Engineer", "company": "X"}
                        ]
                    }
                }
            ]
        return []

    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake_pg)):
        out = await workflows.prefill_from_profile({"user_id": uuid4()})

    assert out["target_role"] == "Staff Backend Engineer"
    assert out["recent_role"] == "Senior Software Engineer"


async def test_prefill_returns_empty_when_nothing_found():
    """New user with no profile → no fields filled."""
    with patch("agents.tools.auto.pg_query", new=AsyncMock(return_value=[])):
        out = await workflows.prefill_from_profile({"user_id": uuid4()})
    assert out == {}


async def test_prefill_does_not_clobber_existing_state():
    """If user explicitly typed a target_role this turn, don't overwrite it."""

    async def fake_pg(sql, params=()):
        if "FROM users" in sql:
            return [{"preferences": {"target_roles": ["Old Role"]}}]
        return []

    with patch("agents.tools.auto.pg_query", new=AsyncMock(side_effect=fake_pg)):
        out = await workflows.prefill_from_profile(
            {"user_id": uuid4(), "target_role": "New Role"}
        )
    assert "target_role" not in out


async def test_prefill_swallows_pg_errors():
    """A PG hiccup must NOT block the build flow."""
    with patch(
        "agents.tools.auto.pg_query",
        new=AsyncMock(side_effect=ConnectionError("PG down")),
    ):
        out = await workflows.prefill_from_profile({"user_id": uuid4()})
    assert out == {}


# ─────────────────────────────────────────────────────────────────────
# Refine loop routing
# ─────────────────────────────────────────────────────────────────────


def test_route_after_review_returns_end_when_no_edit():
    from langgraph.constants import END

    state = {"_review_decision": {"approved": True}}
    assert workflows._route_after_review(state) == END


def test_route_after_review_routes_to_target_role_clear():
    state = {"_review_decision": {"edit_step": "target_role"}}
    assert workflows._route_after_review(state) == "clear_target_role"


def test_route_after_review_handles_recent_and_wins():
    state = {"_review_decision": {"edit_step": "recent_role"}}
    assert workflows._route_after_review(state) == "clear_recent_role"
    state = {"_review_decision": {"edit_step": "top_3_wins"}}
    assert workflows._route_after_review(state) == "clear_top_3_wins"


def test_route_after_review_unknown_edit_step_ends():
    """Defensive: an unrecognised edit_step value must not loop forever."""
    from langgraph.constants import END

    state = {"_review_decision": {"edit_step": "bogus"}}
    assert workflows._route_after_review(state) == END


async def test_clear_node_wipes_field_and_decision():
    """_make_clear_node returns a fn that nulls the named field + decision."""
    clear = workflows._make_clear_node("target_role")
    update = await clear({"target_role": "Old", "_review_decision": {"x": 1}})
    assert update == {"target_role": None, "_review_decision": None}


# ─────────────────────────────────────────────────────────────────────
# Graph wiring smoke
# ─────────────────────────────────────────────────────────────────────


def test_build_from_scratch_graph_includes_prefill_and_clear_nodes():
    """Walk the compiled graph and verify the new nodes are reachable."""
    g = workflows.build_from_scratch_graph()
    drawn = g.get_graph()
    names = set(drawn.nodes.keys())
    for required in (
        "prefill",
        "ask_target_role",
        "ask_recent_role",
        "ask_top_3_wins",
        "draft_v1",
        "hitl_review",
        "clear_target_role",
        "clear_recent_role",
        "clear_top_3_wins",
    ):
        assert required in names, f"missing node: {required} (got {names})"
