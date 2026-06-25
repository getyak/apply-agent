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
    """Surface job matches for the current user from the ingested jobs table.

    P2-3: now backed by real data from the jobmatch ETL (agents/jobs/ingest.py
    pulls Greenhouse / Lever / Ashby boards into the ``jobs`` PG table). When
    no rows exist yet (cron not run), returns status="empty" so the dock can
    say "no jobs in the index yet" instead of inventing.

    Args:
      role: free-text keyword (e.g. "senior backend engineer"). Matched by
        ILIKE against ``role_title``. Optional.
      location: location filter (currently unused — schema doesn't expose
        location yet). Optional.
      remote_only: if true, prefer jobs whose title contains "remote".
      limit: 1..25, default 10.

    Returns:
      ``{status, agent, action, count, items}`` — items are
      ``{id, company, role_title, url, posted_date}``. Sorted by recency.
    """
    user_id = _require_user()
    limit = max(1, min(25, int(limit or 10)))

    from agents.tools.auto import pg_query

    sql_parts = [
        "SELECT id, company, role_title, url, posted_date",
        "FROM jobs",
        "WHERE is_active = true",
    ]
    params: list[Any] = []
    if role and role.strip():
        sql_parts.append("AND role_title ILIKE %s")
        params.append(f"%{role.strip()}%")
    if remote_only:
        sql_parts.append("AND role_title ILIKE %s")
        params.append("%remote%")
    sql_parts.append("ORDER BY posted_date DESC NULLS LAST, created_at DESC")
    sql_parts.append("LIMIT %s")
    params.append(limit)
    sql = " ".join(sql_parts)

    try:
        rows = await pg_query(sql, tuple(params))
    except Exception as exc:  # noqa: BLE001
        log.error("dock_tools.find_jobs.pg_failed", error=str(exc))
        return {
            "status": "error",
            "agent": "jobmatch_agent",
            "action": "find_matches",
            "items": [],
            "summary": "Job lookup hit a DB error.",
        }

    if not rows:
        return {
            "status": "empty",
            "agent": "jobmatch_agent",
            "action": "find_matches",
            "count": 0,
            "items": [],
            "summary": (
                "No jobs in the index yet matching that query. "
                "The board ETL may not have run, or the filter is too tight."
            ),
        }

    items = [
        {
            "id": str(r.get("id")),
            "company": r.get("company"),
            "role_title": r.get("role_title"),
            "url": r.get("url"),
            "posted_date": (
                r["posted_date"].isoformat()
                if r.get("posted_date") and hasattr(r["posted_date"], "isoformat")
                else None
            ),
        }
        for r in rows
    ]
    return {
        "status": "ok",
        "agent": "jobmatch_agent",
        "action": "find_matches",
        "count": len(items),
        "filters": {"role": role, "remote_only": remote_only, "location": location},
        "items": items,
        "user_id": str(user_id),
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
# polish_bullet — vibe edit on ONE bullet of a résumé (P2-2 / P2-6).
# ---------------------------------------------------------------------------
#
# Lets the dock LLM act on "make the third bullet sharper" / "shorten the
# Python one" requests stably instead of falling back to whole-section
# rewrites. Wraps resume_agent.propose_bullet_edit, which already runs the
# fabrication_guard + writes a row to resume_suggestions (status=proposed).
# The frontend renders the proposal as an accept/reject card.
#
# The LLM must know the bullet_stable_id. Today that comes from one of:
#   1. The user_brief block's active-résumé section (when we surface bullets there)
#   2. A prior list_my_applications / surface-bullets call
#   3. The frontend pre-binding ID into the dock turn when the user
#      clicked a bullet to "vibe-edit" it.
#
# If the LLM doesn't have an ID, it should ask_clarification first
# ("which bullet? quoting a few words helps").


@tool
async def polish_bullet(
    resume_id: str,
    bullet_stable_id: str,
    instruction: str,
) -> dict[str, Any]:
    """Revise ONE bullet of a résumé in place from a natural-language instruction.

    Use this when the user asks to refine a specific line ("make the third
    bullet sharper", "drop the percentage from the Stripe one"). Do NOT use
    this for whole-résumé changes — tailor_resume covers that.

    Args:
      resume_id: UUID of the résumé containing the bullet.
      bullet_stable_id: stable ID of the bullet (read it from the active
        résumé section of your user_brief, or from a prior list/select tool
        result, or from frontend context). If you don't have one, call
        ``ask_clarification`` first instead of guessing.
      instruction: free-text guidance ("shorten to 12 words", "quantify the
        impact", "remove the brand name"). Will NOT introduce fabricated
        entities — the fabrication guard blocks that automatically.

    Returns:
      ``{status, agent, action, suggestion?, reason?}`` — on success the
      suggestion dict has ``{id, before, after, change_type, explanation}``
      and a row is written to ``resume_suggestions`` (status='proposed')
      for the dock to render as an accept/reject card.
    """
    from uuid import UUID as _UUID

    user_id = _require_user()
    try:
        resume_uuid = _UUID(str(resume_id))
    except (ValueError, TypeError):
        return {"status": "error", "message": "invalid resume_id"}

    instruction = (instruction or "").strip()
    bullet_stable_id = (bullet_stable_id or "").strip()
    if not instruction:
        return {"status": "error", "message": "instruction must be non-empty"}
    if not bullet_stable_id:
        return {"status": "error", "message": "bullet_stable_id required"}

    from agents.nodes import resume_agent

    try:
        result = await resume_agent.propose_bullet_edit(
            resume_id=resume_uuid,
            bullet_stable_id=bullet_stable_id,
            instruction=instruction,
            user_id=user_id,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("dock_tools.polish_bullet.failed", error=str(exc))
        return {"status": "error", "message": str(exc)}

    return {
        "status": "ok" if result.get("ok") else "rejected",
        "agent": "resume_agent",
        "action": "polish_bullet",
        "suggestion": result if result.get("ok") else None,
        "reason": result.get("reason") if not result.get("ok") else None,
    }


# ---------------------------------------------------------------------------
# ask_clarification — proactive HITL question when args are missing (P1-4).
# ---------------------------------------------------------------------------
#
# Before this tool existed, an under-specified user request ("find me jobs")
# returned ``status: needs_args`` and let the gateway pop a form. That broke
# the conversational flow. With ask_clarification, the dock LLM can keep the
# dialogue going: it raises a question via LangGraph ``interrupt()``, the
# server emits an SSE ``hitl`` frame, the client renders inline options /
# input box, the user answers, ``/ask/resume`` continues the same thread.
#
# Use it when:
#   - find_jobs has no preferences (ask "what kind of role?")
#   - tailor_resume has no job_id (ask "which job?", offer chips)
#   - draft_cover_letter has no application context (same)
#   - the user's request is genuinely ambiguous (offer 2-3 interpretations)
#
# Don't use it when:
#   - you can answer from context already (use the answer, don't re-ask)
#   - the answer is obvious or trivial


@tool
def ask_clarification(
    question: str,
    options: list[str] | None = None,
    placeholder: str | None = None,
    intent_hint: str | None = None,
) -> dict[str, Any]:
    """Pause and ask the user a focused question before proceeding.

    Use this when you genuinely need ONE piece of info to act and the user
    hasn't given it. Show 2-4 ``options`` chips when there's a small
    discrete answer set ("which job?", "remote or onsite?"); leave
    ``options`` empty when free-text is the only reasonable input ("paste
    the JD URL"). After the user responds, the dock continues this same
    turn — you'll receive their answer as the next message.

    Args:
      question: one short, specific question (≤ 200 chars). Phrase as a
        question. Don't apologise; don't say "I need to know …" — just ask.
      options: 2-4 short chip labels (≤ 60 chars each). Omit for free text.
      placeholder: optional placeholder for the free-text input box.
      intent_hint: optional one-word tag the gateway can use to render the
        clarification card (e.g. "job_pick", "preferences", "url_paste").

    Returns: the user's reply as a string. The LLM should immediately use
    that reply as input to the next tool — do NOT re-ask the same thing.

    Examples (good):
      ask_clarification("Which job should I tailor against?",
                        options=["Stripe Staff", "Linear PM", "Anthropic MTS"])
      ask_clarification("What kind of role are you most interested in today?",
                        placeholder="e.g. senior backend engineer, remote")
      ask_clarification("Did you mean the one in SF or remote?",
                        options=["SF", "Remote", "Both"])
    """
    from langgraph.types import interrupt

    _require_user()  # cheap auth boundary; refuses outside a dock turn
    cleaned_q = (question or "").strip()
    if not cleaned_q:
        return {
            "status": "error",
            "message": "ask_clarification requires a non-empty question",
        }
    cleaned_options: list[str] = []
    if options:
        for opt in options[:4]:
            text = str(opt).strip()
            if text:
                cleaned_options.append(text[:60])

    payload = {
        "kind": "clarification",
        "question": cleaned_q[:200],
        "options": cleaned_options,
        "placeholder": (placeholder or "")[:120] or None,
        "intent_hint": (intent_hint or "")[:40] or None,
    }
    # interrupt() returns whatever value /ask/resume's payload had —
    # typically the user's plain-text answer. Coerce to str.
    answer = interrupt(payload)
    if isinstance(answer, dict):
        answer = answer.get("text") or answer.get("value") or ""
    return str(answer or "").strip()


# ---------------------------------------------------------------------------
# web_search / web_fetch — open-web sensing tools (P1-1).
# ---------------------------------------------------------------------------
#
# These give the Dock LLM the ability to look things up that aren't in our
# DB: company interview process write-ups (Glassdoor / Reddit / blog posts),
# layoff news, technology trends, recruiter background, anything else the
# user might reasonably ask about. Without these the "search the web for
# Anthropic's interview process" / "is this company hiring?" / "what does
# their CEO say about hiring philosophy?" paths are all blank.
#
# Behaviour:
#   - web_search uses Tavily when TAVILY_API_KEY is set, else falls back
#     to DuckDuckGo lite scraping (no key needed).
#   - web_fetch is a stripped-down readability — text only, 8k char cap.
#
# Both are auto-permission (no HITL). They make outbound HTTP only; no
# credentials, no writes. Cost is the LLM tokens it takes to digest the
# result (capped by the dock's regular budget).


@tool
async def web_search(query: str, max_results: int = 5) -> dict[str, Any]:
    """Search the open web. Use this when the user asks about something that
    isn't in their own data — company background, interview formats, market
    news, technical references, recruiter info.

    Args:
      query: a focused natural-language query (1-12 words works best).
      max_results: how many hits to return, capped at 10. Default 5.

    Returns:
      ``{status, source, query, results: [{title, url, snippet}]}``.
      ``source`` is "tavily" or "duckduckgo" depending on which backend
      answered. On failure ``status="error"`` with a ``message`` and
      empty ``results``.

    Tip: pass the *result urls* into ``web_fetch`` if you need the full
    body of a specific hit. Don't ``web_fetch`` blindly — read the
    snippets first, the search results are usually enough.
    """
    _require_user()  # cheap auth boundary, no PII in result
    from agents.tools.web import web_search as _do_search

    return await _do_search(query, max_results=max_results)


@tool
async def web_fetch(url: str) -> dict[str, Any]:
    """Fetch a URL and return its extracted text body (8k chars max).

    Use this to read the full content of a specific page — typically a URL
    you got from ``web_search``. Returns ``{status, url, title, text, length}``;
    on failure ``{status: 'error', url, message}``.

    Args:
      url: must start with http:// or https://. Internal URLs and file://
        are rejected.

    Beware: SPAs that require JavaScript to render will return empty text.
    For those, rely on the search snippet instead. Don't fetch more than
    ~3 URLs per turn — each is a network round-trip.
    """
    _require_user()
    from agents.tools.web import web_fetch as _do_fetch

    return await _do_fetch(url)


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
    ask_clarification,
    recall_user_memory,
    recall_past_applications,
    recall_weak_points,
    list_my_applications,
    tailor_resume,
    polish_bullet,
    find_jobs,
    start_mock_interview,
    draft_cover_letter,
    build_resume_from_scratch,
    trends_today,
    web_search,
    web_fetch,
]
