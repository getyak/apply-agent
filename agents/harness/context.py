"""Context window compression — pre_model_hook triggered when token budget hot.

Strategy (docs/architecture/agent-harness.md § Context Window 管理):
  - keep system prompt always
  - keep most recent 5 turns intact
  - summarize older messages into a single "[summary of N earlier steps]" AIMessage
  - on second overflow: tool-call offloading (Phase 2, not in MVP)

Caller: agents/harness/guards.py sets state["_needs_compaction"] when over the
token budget. The compaction step is wired into the dock graph via
``dock_pre_model_hook`` below — a composed pre-hook that runs both
guards.pre_model_hook (iteration / consecutive-error budget) and
maybe_compact in one shot so create_react_agent only sees one hook.

P0-4 fix: before this change maybe_compact was dead code — the dock
graph never passed a pre_model_hook so post_model_hook would flip
``_needs_compaction = True`` and nobody would ever act on it. Long
dock sessions could grow context unboundedly. ``dock_pre_model_hook``
closes the loop.
"""
from __future__ import annotations

from typing import Any

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
)

KEEP_RECENT_TURNS = 5  # each turn ≈ 2 messages (user + assistant)


def maybe_compact(state: dict[str, Any]) -> dict[str, Any]:
    """If state flags compaction needed, return a state-update that summarizes
    old context. No-op otherwise.

    Returns: dict with new "messages" array (LangGraph add_messages reducer
    will REPLACE since we set the canonical list).
    """
    if not state.get("_needs_compaction"):
        return {}

    msgs: list[BaseMessage] = state.get("messages", [])
    if len(msgs) <= KEEP_RECENT_TURNS * 2 + 1:
        return {"_needs_compaction": False}

    system_msgs = [m for m in msgs if isinstance(m, SystemMessage)]
    rest = [m for m in msgs if not isinstance(m, SystemMessage)]
    keep_tail = rest[-(KEEP_RECENT_TURNS * 2) :]
    summarized_head = rest[: -(KEEP_RECENT_TURNS * 2)]

    head_preview = " · ".join(
        m.content[:60] if isinstance(m.content, str) else str(m.content)[:60]
        for m in summarized_head
        if isinstance(m, (HumanMessage, AIMessage))
    )
    summary = SystemMessage(
        content=(
            f"[Summary of {len(summarized_head)} earlier messages, compacted to save tokens]: "
            f"{head_preview[:600]}"
        )
    )

    new_messages = system_msgs + [summary] + keep_tail
    return {"messages": new_messages, "_needs_compaction": False}


def dock_pre_model_hook(state: dict[str, Any]) -> dict[str, Any]:
    """Composed pre-hook for the dock ReAct graph.

    Runs in this order:
      1. ``guards.pre_model_hook`` — bumps iteration counter, raises
         BudgetExhausted on consecutive errors.
      2. ``maybe_compact`` — if guards' post-hook flagged compaction
         needed (token budget over 80k), rewrite messages now BEFORE
         the model sees them. This is the only place that consumes the
         ``_needs_compaction`` flag.

    Returns the merged state-update dict. Both sub-hooks return small
    update dicts; we shallow-merge them (with maybe_compact's keys
    winning since it can rewrite ``messages``).
    """
    # Lazy import to avoid harness.guards ↔ harness.context cycle on import.
    from agents.harness.guards import pre_model_hook as _guard_pre

    update: dict[str, Any] = {}
    update.update(_guard_pre(state) or {})

    # Compose the "after-guards" view so compaction sees the latest counter.
    composed_state: dict[str, Any] = {**state, **update}
    update.update(maybe_compact(composed_state) or {})
    return update
