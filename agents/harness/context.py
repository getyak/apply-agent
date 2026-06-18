"""Context window compression — pre_model_hook triggered when token budget hot.

Strategy (docs/architecture/agent-harness.md § Context Window 管理):
  - keep system prompt always
  - keep most recent 5 turns intact
  - summarize older messages into a single "[summary of N earlier steps]" AIMessage
  - on second overflow: tool-call offloading (Phase 2, not in MVP)

Caller: agents/harness/guards.py sets state["_needs_compaction"] when over the
budget; this module checks the flag at the top of pre_model_hook (composed in
llm.py) and rewrites state["messages"] in place.
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
