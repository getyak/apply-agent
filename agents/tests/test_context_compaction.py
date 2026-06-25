"""Unit tests for agents/harness/context.py — the compaction hook.

Locks down the P0-4 fix:
  - maybe_compact: no-op when _needs_compaction is False
  - maybe_compact: replaces old messages with a summary when flagged
  - maybe_compact: preserves system messages + tail of recent turns
  - dock_pre_model_hook: composes guards.pre_model_hook + maybe_compact
  - dock_pre_model_hook: forwards iteration counter into compaction view
  - build_dock_graph wires pre_model_hook so the hook fires (smoke)

The integration smoke is the only place where we touch build_dock_graph;
all the logic lives in pure unit tests against the hook function.
"""
from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from agents.harness.context import (
    KEEP_RECENT_TURNS,
    dock_pre_model_hook,
    maybe_compact,
)

# ─────────────────────────────────────────────────────────────────────
# maybe_compact direct
# ─────────────────────────────────────────────────────────────────────


def test_maybe_compact_noop_when_flag_unset():
    state = {"messages": [HumanMessage(content="hi")], "_needs_compaction": False}
    assert maybe_compact(state) == {}


def test_maybe_compact_noop_when_under_threshold():
    """Short threads must NOT be compacted even if the flag is set."""
    short = [SystemMessage(content="sys"), HumanMessage(content="hi")]
    state = {"messages": short, "_needs_compaction": True}
    update = maybe_compact(state)
    # Just resets the flag, doesn't rewrite messages.
    assert update == {"_needs_compaction": False}


def test_maybe_compact_rewrites_long_history():
    """A long history collapses old messages into a single summary SystemMessage."""
    # Build: 1 system + 30 alternating human/AI messages = 31 total.
    msgs = [SystemMessage(content="sys")]
    for i in range(15):
        msgs.append(HumanMessage(content=f"user-{i}"))
        msgs.append(AIMessage(content=f"reply-{i}"))
    state = {"messages": msgs, "_needs_compaction": True}

    update = maybe_compact(state)
    new_msgs = update["messages"]

    # Layout: system + summary + last 10 (5 turns × 2)
    assert len(new_msgs) == 1 + 1 + KEEP_RECENT_TURNS * 2

    assert isinstance(new_msgs[0], SystemMessage)
    assert new_msgs[0].content == "sys"

    assert isinstance(new_msgs[1], SystemMessage)
    assert "Summary of" in new_msgs[1].content
    # Should reference how many were collapsed: 30 - 10 = 20.
    assert "20" in new_msgs[1].content

    # Tail must be the most recent 5 turns intact.
    assert new_msgs[2].content == "user-10"
    assert new_msgs[-1].content == "reply-14"

    assert update["_needs_compaction"] is False


def test_maybe_compact_keeps_multiple_system_messages():
    """Surface-specific extra_system_blocks (dock_agent's pattern) must survive."""
    msgs = [
        SystemMessage(content="base"),
        SystemMessage(content="resume_studio_context"),
    ]
    for i in range(15):
        msgs.append(HumanMessage(content=f"u-{i}"))
        msgs.append(AIMessage(content=f"a-{i}"))

    update = maybe_compact({"messages": msgs, "_needs_compaction": True})
    new = update["messages"]
    # Both system messages preserved, summary inserted, then the tail.
    assert isinstance(new[0], SystemMessage) and new[0].content == "base"
    assert (
        isinstance(new[1], SystemMessage)
        and new[1].content == "resume_studio_context"
    )
    assert isinstance(new[2], SystemMessage) and "Summary of" in new[2].content


# ─────────────────────────────────────────────────────────────────────
# dock_pre_model_hook integration
# ─────────────────────────────────────────────────────────────────────


def test_dock_pre_hook_bumps_iterations_without_compaction():
    """When _needs_compaction is unset, hook just runs the guards (iter +1)."""
    state = {
        "messages": [HumanMessage(content="hi")],
        "_iterations": 4,
        "consecutive_errors": 0,
    }
    update = dock_pre_model_hook(state)
    assert update["_iterations"] == 5
    # No "messages" key — compaction didn't fire.
    assert "messages" not in update


def test_dock_pre_hook_runs_both_guards_and_compaction():
    """When _needs_compaction is set + history is long, hook does both."""
    msgs = [SystemMessage(content="sys")]
    for i in range(15):
        msgs.append(HumanMessage(content=f"u-{i}"))
        msgs.append(AIMessage(content=f"a-{i}"))
    state = {
        "messages": msgs,
        "_iterations": 4,
        "consecutive_errors": 0,
        "_needs_compaction": True,
    }
    update = dock_pre_model_hook(state)
    # guards.pre_model_hook bumped iter to 5.
    assert update["_iterations"] == 5
    # maybe_compact rewrote messages and cleared the flag.
    assert "messages" in update
    assert update["_needs_compaction"] is False


def test_dock_pre_hook_raises_on_consecutive_errors():
    """Guards still raise BudgetExhausted before compaction runs."""
    from agents.harness.guards import BudgetExhausted

    state = {
        "messages": [HumanMessage(content="hi")],
        "_iterations": 0,
        "consecutive_errors": 99,  # over the cap
        "_needs_compaction": True,
    }
    with pytest.raises(BudgetExhausted):
        dock_pre_model_hook(state)


# ─────────────────────────────────────────────────────────────────────
# build_dock_graph smoke — does it actually pass the hook through?
# ─────────────────────────────────────────────────────────────────────


def test_build_dock_graph_wires_pre_model_hook(monkeypatch):
    """The dock graph factory must register dock_pre_model_hook.

    Detection: monkeypatch create_react_agent and assert the kwarg shows up
    with our hook function.
    """
    captured: dict[str, object] = {}

    def fake_create_react_agent(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(
        "agents.coordinator.dock_agent.create_react_agent", fake_create_react_agent
    )
    monkeypatch.setattr(
        "agents.coordinator.dock_agent.pick_model", lambda *a, **kw: object()
    )

    from agents.coordinator import dock_agent

    dock_agent.build_dock_graph.cache_clear()
    dock_agent.build_dock_graph(tier="general")

    assert "pre_model_hook" in captured
    assert captured["pre_model_hook"] is dock_pre_model_hook
    assert "post_model_hook" in captured  # P0-1 path still wired
