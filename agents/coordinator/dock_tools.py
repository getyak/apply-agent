"""Dock Agent's tool registry.

Caller: ``agents.coordinator.dock_agent`` registers ``DOCK_TOOLS`` on the
``create_react_agent`` it builds.

Why this module exists:
  The Sprint 1 of docs/design/chat-agent-system-redesign.md replaces the
  router/dispatch if-else chain with a main-loop ReAct agent (Dock). Each
  domain agent — resume / jobmatch / interview / appprep — is exposed here
  as a single LangGraph ``@tool`` so the Dock LLM can choose which one to
  invoke instead of relying on an ahead-of-time regex/V4-Flash classifier.

  The tools deliberately return small structured ``dict`` envelopes (status,
  agent, action, summary, plus a small ``payload``) — never a huge resume
  blob — so the Dock can show artifact cards without blowing its own
  context budget. Anything large stays in PG; the dict points at it.

The tools are intentionally *thin wrappers*: each delegates to the
existing node-level helpers (``resume_agent.customize``,
``interview_agent.build_mock_graph``, ``tools.applications.list_applications``,
``coordinator.workflows.start_build_from_scratch``). This keeps the contract
with the rest of the agent layer stable (same auditing, same DB writes,
same fabrication-guards) while letting us iterate on the Dock-level loop.

Trend agent is intentionally absent — there is no ``agents/nodes/trend_agent.py``
on disk today (the design doc lists 5 agents but the codebase ships 4); the
``trends_today`` tool returns ``not_implemented`` so the Dock can still reason
about the intent without crashing on import.
"""
from __future__ import annotations

import contextvars
from typing import Any
from uuid import UUID

import structlog
from langchain_core.tools import tool

log = structlog.get_logger("agents.coordinator.dock_tools")


# ---------------------------------------------------------------------------
# In-graph context — propagated by dock_agent via contextvars.
# ---------------------------------------------------------------------------
#
# LangGraph's ``create_react_agent`` doesn't natively let tool implementations
# read ``user_id`` from a typed state without InjectedState plumbing — and
# (per agent-harness.md known risk #1) post_model_hook still doesn't inject
# state cleanly. We side-step the issue with a contextvar that the dock agent
# sets before each ``ainvoke``; tools read it without changing their
# JSON-schema-visible parameters (the LLM never sees user_id, which is the
# right boundary anyway — it's auth, not a tool argument).

_USER_CTX: contextvars.ContextVar[UUID | None] = contextvars.ContextVar(
    "_dock_user_id", default=None
)
_THREAD_CTX: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "_dock_thread_id", default=None
)
_SURFACE_CTX: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "_dock_surface", default=None
)


def set_dock_context(
    *, user_id: UUID, thread_id: str, surface: str | None
) -> tuple[
    contextvars.Token[UUID | None],
    contextvars.Token[str | None],
    contextvars.Token[str | None],
]:
    """Bind per-turn dock context. Caller must ``reset_dock_context``."""
    return (
        _USER_CTX.set(user_id),
        _THREAD_CTX.set(thread_id),
        _SURFACE_CTX.set(surface),
    )


def reset_dock_context(
    tokens: tuple[
        contextvars.Token[UUID | None],
        contextvars.Token[str | None],
        contextvars.Token[str | None],
    ],
) -> None:
    user_tok, thread_tok, surface_tok = tokens
    _USER_CTX.reset(user_tok)
    _THREAD_CTX.reset(thread_tok)
    _SURFACE_CTX.reset(surface_tok)


def _require_user() -> UUID:
    user = _USER_CTX.get()
    if user is None:
        raise RuntimeError(
            "dock tool called without an active user context — set_dock_context() first"
        )
    return user


# ---------------------------------------------------------------------------
# propose_plan — the plan-first tool (P0-B).
# ---------------------------------------------------------------------------
#
# The dock system prompt instructs the model to call ``propose_plan`` BEFORE
# any execution tool. We don't actually run anything here; we just return
# the validated plan so /ask/stream can stream it back to the dock as a
# ``task_graph`` SSE frame. The plan is allowed to be a single-step one
# (e.g. "list_applications") — the goal is "the dock UI mirrors what's about
# to happen", not "every action is multi-step".


@tool
def narrate(thought: str) -> dict[str, Any]:
    """Surface a single short narration line to the user *before* the next
    execution tool.

    Call this immediately before each non-recall execution tool (tailor_resume,
    find_jobs, draft_cover_letter, start_mock_interview, list_my_applications,
    build_resume_from_scratch, trends_today). One sentence, present tense,
    user-facing — *why* you are about to do the next thing, NOT chain-of-thought.

    Examples (good):
      - "Pulling your last three Stripe applications first so the brief lines up."
      - "Sweeping the master résumé for places to lean on payments work."
      - "Looking up which weak points you flagged last week."

    Examples (bad):
      - "Let me think about this..."   (no information)
      - "I will now call tailor_resume" (mentions tool name, leaks plumbing)
      - "Based on my analysis of section 4.2..." (chain-of-thought leak)

    Args:
      thought: a single user-facing sentence (≤ 160 chars). Will be capped
        server-side. Empty / whitespace-only inputs are dropped.

    Returns:
      ``{"status": "ok", "narration": "..."}`` — the dock streams this as a
      ``narrator`` SSE event (then NDJSON `narrator` frame) so the UI can
      render it as an italic chip above the tool trace.
    """
    cleaned = (thought or "").strip()
    if not cleaned:
        return {"status": "ok", "narration": ""}
    return {"status": "ok", "narration": cleaned[:160]}


@tool
def propose_plan(
    user_goal: str,
    steps: list[dict[str, Any]],
) -> dict[str, Any]:
    """Declare the multi-step plan for this turn before executing anything.

    Args:
      user_goal: a short paraphrase of what the user asked for, e.g.
        "tailor my résumé for the Stripe staff eng role". Shown in the dock
        plan card header.
      steps: list of plan steps. Each step must be a JSON object with:
          - "step":  short identifier (e.g. "customize_resume")
          - "agent": which agent will run this step
                     (resume_agent | jobmatch_agent | interview_agent
                      | appprep_agent | trend_agent | coordinator)
          - "label": human-facing one-liner shown in the plan card row
          - "requires_review" (optional, default false): HITL gate flag

    Returns:
      ``{"status": "ok", "plan_id": "...", "user_goal": "...", "plan": [...]}``
      — the dock pushes this plan to the client immediately; subsequent
      execution tools light up each row in order. Call this exactly once
      per user turn before any execution tool.
    """
    plan_id = f"plan-{abs(hash((user_goal, len(steps)))) % 10**8}"
    normalised: list[dict[str, Any]] = []
    for s in steps:
        if not isinstance(s, dict):
            continue
        normalised.append(
            {
                "step": str(s.get("step", ""))[:80],
                "agent": str(s.get("agent", "coordinator"))[:40],
                "label": str(s.get("label", ""))[:200],
                "requires_review": bool(s.get("requires_review", False)),
            }
        )
    return {
        "status": "ok",
        "plan_id": plan_id,
        "user_goal": user_goal[:200],
        "plan": normalised,
    }


# ---------------------------------------------------------------------------
# Domain tools — each wraps an existing node action with a thin envelope.
# ---------------------------------------------------------------------------


@tool
async def tailor_resume(
    job_id: str,
    base_resume_id: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    """Customise the user's master résumé for a specific job (HITL-gated).

    Args:
      job_id: UUID of a row in ``jobs`` to tailor against. Required.
      base_resume_id: optional override of which résumé version to start
        from. Default = current master (highest-version is_base row).
      notes: optional free-text guidance ("emphasize my Stripe payments
        work") — the model uses this only as steering, never to invent
        experience.

    Returns:
      ``{status, agent, action, needs_user_review, artifact}`` — artifact
      is small (id + version + change_log summary), enough for the dock to
      render a diff card.
    """
    user_id = _require_user()
    # We don't fetch the base resume / JD content here because the actual
    # ``resume_agent.customize`` requires both as dicts. The TS gateway has
    # the data pre-loaded for the legacy /resume/customize path; from the
    # dock we surface ``needs`` so the next-step is structured.
    return {
        "status": "needs_args",
        "agent": "resume_agent",
        "action": "customize",
        "needs": ["base_resume_content", "jd_text"],
        "args": {
            "job_id": job_id,
            "base_resume_id": base_resume_id,
            "notes": notes,
            "user_id": str(user_id),
        },
        "next_endpoint": "/resume/customize",
        "summary": (
            "Ready to tailor. The dock will hand off to the résumé customise "
            "endpoint with the loaded base + JD."
        ),
    }


@tool
async def find_jobs(
    role: str | None = None,
    location: str | None = None,
    remote_only: bool = False,
    limit: int = 10,
) -> dict[str, Any]:
    """Surface job matches for the current user (uses jobmatch_agent).

    Args:
      role: target role keyword (e.g. "senior backend engineer"). Optional.
      location: location filter (e.g. "remote", "SF"). Optional.
      remote_only: if true, restrict to remote-flagged jobs.
      limit: 1..25, default 10.

    Returns:
      ``{status, agent, action, items}`` — list of {id, company, role_title,
      match_score} dicts. Today this is a stub that returns ``not_implemented``
      with the request echoed; the dock surfaces the intent + a note so the
      user knows we picked the right path.
    """
    user_id = _require_user()
    limit = max(1, min(25, int(limit or 10)))
    return {
        "status": "not_implemented",
        "agent": "jobmatch_agent",
        "action": "find_matches",
        "args": {
            "role": role,
            "location": location,
            "remote_only": remote_only,
            "limit": limit,
            "user_id": str(user_id),
        },
        "items": [],
        "summary": (
            "Job matching is wired but not generating yet — surfaced the "
            "request so we can prioritise it."
        ),
    }


@tool
async def start_mock_interview(
    mode_slug: str = "scene_recreation",
    company: str | None = None,
    role: str | None = None,
    round_type: str | None = None,
) -> dict[str, Any]:
    """Start a Mock interview session. Returns the thread_id + first question.

    Args:
      mode_slug: one of the built-in modes (``scene_recreation`` |
        ``pressure_drill`` | ``warm_up`` | ``rapid_fire``) or a user-custom
        slug.
      company: target company (e.g. "Stripe"). Optional.
      role: target role (e.g. "staff engineer"). Optional.
      round_type: e.g. "phone_screen" | "system_design" | "behavioral".
        Optional.

    Returns:
      ``{status, agent, action, thread_id, current_question, mode_slug}``
      — the caller (dock) renders the first question and reads/writes via
      ``/mock/resume``.
    """
    user_id = _require_user()
    from uuid import uuid4

    from agents.harness.checkpointer import mock_thread_id
    from agents.nodes import interview_agent

    mode = await interview_agent.load_mode(mode_slug, user_id=user_id)
    if not mode:
        mode = await interview_agent.load_mode("scene_recreation")
    if not mode:
        return {
            "status": "error",
            "agent": "interview_agent",
            "action": "build_mock_graph",
            "summary": "No Mock modes are available — the database seed may be missing.",
        }

    session_id = uuid4()
    graph = interview_agent.build_mock_graph(mode)
    cfg = {"configurable": {"thread_id": mock_thread_id(str(session_id))}}
    initial_state = {
        "user_id": user_id,
        "session_id": session_id,
        "mode": mode,
        "company": company,
        "role": role,
        "round_type": round_type,
    }
    state = await graph.ainvoke(initial_state, config=cfg)
    return {
        "status": "ok",
        "agent": "interview_agent",
        "action": "build_mock_graph",
        "thread_id": mock_thread_id(str(session_id)),
        "session_id": str(session_id),
        "current_question": state.get("_pending_question"),
        "mode_slug": mode.get("slug") if mode else None,
        "summary": (
            f"Mock session ready in {mode.get('display_name') if mode else mode_slug} mode. "
            "Open it in the dock to begin."
        ),
    }


@tool
async def draft_cover_letter(
    job_id: str,
    tone: str = "professional",
) -> dict[str, Any]:
    """Draft a cover letter grounded in the user's master résumé + a JD.

    Args:
      job_id: UUID of a row in ``jobs``. Required.
      tone: ``professional`` | ``friendly`` | ``direct``. Default ``professional``.

    Returns:
      ``{status, agent, action, summary}`` — surfaces intent. The actual
      draft endpoint (``appprep_agent.generate_cover_letter``) needs the
      pre-loaded résumé + parsed JD, which the dock doesn't materialise
      here; we return ``needs_args`` so the dock can chain through.
    """
    user_id = _require_user()
    return {
        "status": "needs_args",
        "agent": "appprep_agent",
        "action": "draft_cover_letter",
        "needs": ["base_resume_content", "parsed_jd"],
        "args": {
            "job_id": job_id,
            "tone": tone,
            "user_id": str(user_id),
        },
        "summary": "Cover-letter draft is queued — chain with the prep endpoint to materialise.",
    }


@tool
async def list_my_applications(limit: int = 25) -> dict[str, Any]:
    """List the user's application pipeline (kanban rows).

    Args:
      limit: max rows to return. Capped at 50.

    Returns:
      ``{status, agent, action, items}`` — list of
      ``{id, company, role_title, status}``. Comes straight from
      ``application_drafts``.
    """
    user_id = _require_user()
    from agents.tools.applications import list_applications

    rows = await list_applications(user_id=user_id)
    capped = rows[: max(1, min(50, int(limit or 25)))]
    return {
        "status": "ok",
        "agent": "applications",
        "action": "list",
        "count": len(capped),
        "items": [
            {
                "id": r.get("id"),
                "company": r.get("company"),
                "role_title": r.get("role_title"),
                "status": r.get("status"),
            }
            for r in capped
        ],
        "summary": f"Found {len(capped)} application row(s).",
    }


@tool
async def build_resume_from_scratch() -> dict[str, Any]:
    """Boot the guided "build a résumé from scratch" workflow.

    No args — the workflow asks chip-style questions one at a time.

    Returns:
      ``{status, agent, action, thread_id, current_question}`` — render the
      first question in the dock; subsequent answers go via
      ``/build_resume/resume``.
    """
    user_id = _require_user()
    from agents.coordinator.workflows import start_build_from_scratch

    return await start_build_from_scratch(user_id=user_id)


@tool
async def trends_today() -> dict[str, Any]:
    """Pull today's market snapshot (trend_agent — not yet implemented).

    Returns:
      ``{status, agent, action, summary}`` — stub today.
    """
    return {
        "status": "not_implemented",
        "agent": "trend_agent",
        "action": "daily_snapshot",
        "summary": (
            "Trend agent is on the roadmap — wired into the plan but not "
            "generating yet."
        ),
    }


# ---------------------------------------------------------------------------
# Memory / context tools — feed the ReAct loop signals about the user.
# ---------------------------------------------------------------------------


@tool
async def recall_user_memory(query: str, limit: int = 5) -> dict[str, Any]:
    """Retrieve user_memories rows semantically relevant to ``query``.

    Args:
      query: natural-language question (e.g. "what kind of roles do I want?")
      limit: max items, capped at 10.

    Returns:
      ``{status, items}`` — list of {kind, summary} dicts. Empty list when
      the table has no rows for this user (the common case until the user
      has had a few sessions). Returns ``status="unavailable"`` if PG is
      unreachable — the dock should reason "no memory found" rather than
      fail the turn.
    """
    user_id = _require_user()
    limit = max(1, min(10, int(limit or 5)))
    try:
        from agents.tools.auto import pg_query

        # Without an embedding pipeline wired here we fall back to recency.
        rows = await pg_query(
            """
            SELECT kind, summary
            FROM user_memories
            WHERE user_id = %s
            ORDER BY updated_at DESC NULLS LAST, created_at DESC
            LIMIT %s
            """,
            (str(user_id), limit),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("dock_tools.recall_user_memory.failed", error=str(exc))
        return {"status": "unavailable", "items": [], "query": query}
    return {
        "status": "ok",
        "items": [
            {"kind": r["kind"], "summary": r["summary"]} for r in rows if r.get("summary")
        ],
        "query": query,
    }


@tool
async def recall_past_applications(limit: int = 10) -> dict[str, Any]:
    """Recall the user's most recent application_drafts rows.

    Args:
      limit: max items, capped at 25.

    Returns:
      ``{status, items}`` — list of {company, role_title, status, updated_at}.
    """
    user_id = _require_user()
    limit = max(1, min(25, int(limit or 10)))
    try:
        from agents.tools.auto import pg_query

        rows = await pg_query(
            """
            SELECT company, role_title, status, updated_at
            FROM application_drafts
            WHERE user_id = %s
            ORDER BY updated_at DESC NULLS LAST, created_at DESC
            LIMIT %s
            """,
            (str(user_id), limit),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("dock_tools.recall_past_applications.failed", error=str(exc))
        return {"status": "unavailable", "items": []}
    return {
        "status": "ok",
        "items": [dict(r) for r in rows],
    }


@tool
async def recall_weak_points(limit: int = 5) -> dict[str, Any]:
    """Recall the user's latest mock-interview weak points (post-session).

    Args:
      limit: max items, capped at 10.

    Returns:
      ``{status, items}`` — list of weak-point dicts harvested from the
      most recent ``interview_sessions.weak_points`` JSON column.
    """
    user_id = _require_user()
    limit = max(1, min(10, int(limit or 5)))
    try:
        from agents.tools.auto import pg_query

        rows = await pg_query(
            """
            SELECT weak_points, completed_at
            FROM interview_sessions
            WHERE user_id = %s AND weak_points IS NOT NULL
            ORDER BY COALESCE(completed_at, created_at) DESC
            LIMIT 3
            """,
            (str(user_id),),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("dock_tools.recall_weak_points.failed", error=str(exc))
        return {"status": "unavailable", "items": []}

    items: list[dict[str, Any]] = []
    for r in rows:
        wp = r.get("weak_points") or []
        if isinstance(wp, list):
            items.extend(wp[:limit])
        if len(items) >= limit:
            break
    return {"status": "ok", "items": items[:limit]}


# ---------------------------------------------------------------------------
# DOCK_TOOLS — registered with ``create_react_agent(tools=DOCK_TOOLS)``.
# ---------------------------------------------------------------------------
#
# Order matters only for prompt rendering — the LLM sees them in this
# sequence, and we want propose_plan and the recall_* tools listed first
# so the system prompt's "plan first, remember, then execute" instruction
# has visual reinforcement.

DOCK_TOOLS = [
    propose_plan,
    narrate,
    recall_user_memory,
    recall_past_applications,
    recall_weak_points,
    list_my_applications,
    tailor_resume,
    find_jobs,
    start_mock_interview,
    draft_cover_letter,
    build_resume_from_scratch,
    trends_today,
]
