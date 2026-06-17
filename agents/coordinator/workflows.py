"""Fixed workflows — non-conversational graphs orchestrating multiple nodes.

Currently:
  - build_from_scratch — guided onboarding for users with no résumé yet
    (ask_target_role → ask_recent_role → ask_top_3_wins → draft_v1 → hitl_review)

UX detail (vantage-ui-mapping.md § 1.5): each question is paired with chip
candidate answers to avoid blank-page anxiety.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from langgraph.constants import END
from langgraph.graph import StateGraph
from langgraph.types import interrupt

from agents.harness.audit import audit
from agents.harness.checkpointer import build_resume_thread_id, get_checkpointer
from agents.harness.state import BuildResumeState
from agents.nodes import resume_agent


# Chip candidates per question — hand-curated to nudge specificity.
TARGET_ROLE_CHIPS = [
    "Senior product designer",
    "Backend engineer",
    "Engineering manager",
    "PM (B2B)",
    "Data scientist",
    "DevRel",
    "Founding engineer",
]

RECENT_ROLE_HINT_CHIPS = [
    "I'm currently in this role",
    "I left ~3 months ago",
    "I'm doing contract work",
    "I'm between jobs",
]


async def ask_target_role(state: BuildResumeState) -> dict[str, Any]:
    decision = interrupt(
        {
            "type": "guided_question",
            "step": "target_role",
            "question": "What role are you going after?",
            "chips": TARGET_ROLE_CHIPS,
            "free_form": True,
        }
    )
    return {"target_role": (decision or {}).get("value", "").strip()}


async def ask_recent_role(state: BuildResumeState) -> dict[str, Any]:
    decision = interrupt(
        {
            "type": "guided_question",
            "step": "recent_role",
            "question": "What's the most recent job you held? (or are still in)",
            "chips": RECENT_ROLE_HINT_CHIPS,
            "free_form": True,
        }
    )
    return {"recent_role": (decision or {}).get("value", "").strip()}


async def ask_top_3_wins(state: BuildResumeState) -> dict[str, Any]:
    decision = interrupt(
        {
            "type": "guided_question",
            "step": "top_3_wins",
            "question": (
                "Tell me 3 things you're proud of from this work — anything you owned, shipped, "
                "or moved a number on."
            ),
            "chips": [],
            "free_form": True,
            "min_entries": 3,
        }
    )
    wins = (decision or {}).get("value", [])
    if isinstance(wins, str):
        wins = [w.strip() for w in wins.split("\n") if w.strip()]
    return {"top_3_wins": wins[:3]}


async def draft_v1(state: BuildResumeState) -> dict[str, Any]:
    async with audit(state["user_id"], "coordinator", "build_resume_draft"):
        result = await resume_agent.build_from_scratch(
            target_role=state.get("target_role", "") or "",
            recent_role=state.get("recent_role", "") or "",
            top_3_wins=state.get("top_3_wins", []) or [],
            user_id=state["user_id"],
        )
        return {"draft_resume_id": result["resume_id"]}


async def hitl_review(state: BuildResumeState) -> dict[str, Any]:
    """Pause and let the user accept / edit the v1 draft."""
    decision = interrupt(
        {
            "type": "review_draft",
            "resume_id": str(state.get("draft_resume_id") or ""),
            "message": (
                "Here's v1 of your résumé. Look it over and approve, or tell me what to change."
            ),
        }
    )
    return {"_review_decision": decision}


def build_from_scratch_graph():
    g: StateGraph = StateGraph(BuildResumeState)
    g.add_node("ask_target_role", ask_target_role)
    g.add_node("ask_recent_role", ask_recent_role)
    g.add_node("ask_top_3_wins", ask_top_3_wins)
    g.add_node("draft_v1", draft_v1)
    g.add_node("hitl_review", hitl_review)

    g.set_entry_point("ask_target_role")
    g.add_edge("ask_target_role", "ask_recent_role")
    g.add_edge("ask_recent_role", "ask_top_3_wins")
    g.add_edge("ask_top_3_wins", "draft_v1")
    g.add_edge("draft_v1", "hitl_review")
    g.add_edge("hitl_review", END)

    return g.compile(checkpointer=get_checkpointer())


async def start_build_from_scratch(user_id: UUID) -> dict[str, Any]:
    """Public entry called by router.dispatch() — kicks off a new build session."""
    session_id = uuid4()
    graph = build_from_scratch_graph()
    config = {"configurable": {"thread_id": build_resume_thread_id(str(user_id), str(session_id))}}
    # First invoke pauses at ask_target_role's interrupt() — the API layer
    # surfaces the question to the dock, the user replies, and the API calls
    # graph.invoke(Command(resume=...)) to continue.
    await graph.ainvoke({"user_id": user_id}, config=config)
    return {
        "agent": "coordinator",
        "action": "build_resume",
        "session_id": str(session_id),
        "thread_id": build_resume_thread_id(str(user_id), str(session_id)),
        "status": "awaiting_user_input",
    }
