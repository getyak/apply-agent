"""Fixed workflows — non-conversational graphs orchestrating multiple nodes.

Currently:
  - build_from_scratch — guided onboarding for users with no résumé yet
    (ask_target_role → ask_recent_role → ask_top_3_wins → draft_v1 → hitl_review)
  - prepare_application — delivery loop core
    (parse_jd → customize_resume → cover_letter → form_answers → mark_ready)
    Drives the TTAR north-star metric (docs/architecture/delivery-loop-plan.md
    § 1). Each stage logs its latency into TTARRecord; saga branches handle
    partial failure by setting state["stage_status"][stage] and continuing.

UX detail (vantage-ui-mapping.md § 1.5): each build-from-scratch question is
paired with chip candidate answers to avoid blank-page anxiety.
"""
from __future__ import annotations

import os
import time
from typing import Any
from uuid import UUID, uuid4

from langgraph.constants import END
from langgraph.graph import StateGraph
from langgraph.types import interrupt

from agents.harness.audit import audit
from agents.harness.checkpointer import build_resume_thread_id, get_checkpointer
from agents.harness.state import BuildResumeState, PrepareApplicationState
from agents.harness.ttar import measure_ttar
from agents.nodes import appprep_agent, jobmatch_agent, resume_agent

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


async def prefill_from_profile(state: BuildResumeState) -> dict[str, Any]:
    """P2-1: pre-populate state from the user's existing profile so we can
    skip questions whose answers are already known.

    Reads users.preferences (target_roles, last_role) and the most recent
    résumé (recent_role from work[0].position). Quietly skips when there's
    nothing useful. Never blocks: any PG hiccup returns an empty update.
    """
    user_id = state["user_id"]
    update: dict[str, Any] = {}
    try:
        from agents.tools.auto import pg_query

        prefs_rows = await pg_query(
            "SELECT preferences FROM users WHERE id = %s", (str(user_id),)
        )
        if prefs_rows:
            prefs = prefs_rows[0].get("preferences") or {}
            if isinstance(prefs, str):
                import json as _json

                try:
                    prefs = _json.loads(prefs)
                except (ValueError, TypeError):
                    prefs = {}
            if isinstance(prefs, dict):
                target_roles = prefs.get("target_roles") or []
                if target_roles and not state.get("target_role"):
                    update["target_role"] = str(target_roles[0])

        resume_rows = await pg_query(
            """
            SELECT content FROM resumes
            WHERE user_id = %s AND deleted_at IS NULL
            ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1
            """,
            (str(user_id),),
        )
        if resume_rows:
            content = resume_rows[0].get("content") or {}
            if isinstance(content, str):
                import json as _json

                try:
                    content = _json.loads(content)
                except (ValueError, TypeError):
                    content = {}
            work = (content.get("work") if isinstance(content, dict) else None) or []
            if work and isinstance(work, list):
                first = work[0] or {}
                position = first.get("position") if isinstance(first, dict) else None
                if position and not state.get("recent_role"):
                    update["recent_role"] = str(position)
    except Exception:  # noqa: BLE001 — pre-fill is purely advisory
        return {}
    return update


async def ask_target_role(state: BuildResumeState) -> dict[str, Any]:
    if state.get("target_role"):
        return {}
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
    if state.get("recent_role"):
        return {}
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
    """Pause and let the user accept / edit the v1 draft.

    P2-1: the decision dict can now carry an ``edit_step`` field with one of
    {"target_role", "recent_role", "top_3_wins"} — if present, route back to
    that ask_X node with the current value cleared so the user can re-answer.
    Without that field, the workflow ends (default = approve).
    """
    decision = interrupt(
        {
            "type": "review_draft",
            "resume_id": str(state.get("draft_resume_id") or ""),
            "message": (
                "Here's v1 of your résumé. Look it over and approve, or tell me "
                "what to change. To edit a specific answer, include "
                "edit_step ∈ {target_role, recent_role, top_3_wins}."
            ),
        }
    )
    return {"_review_decision": decision}


def _route_after_review(state: BuildResumeState) -> str:
    """Decide whether the user wants to edit or ship.

    The decision dict is set by hitl_review. ``edit_step`` (if present) names
    which question to re-ask. We also clear that field on the state so the
    skip-if-known guard at the top of ask_X actually re-prompts.
    """
    decision = state.get("_review_decision") or {}
    if not isinstance(decision, dict):
        return END
    edit_step = decision.get("edit_step")
    if edit_step in ("target_role", "recent_role", "top_3_wins"):
        return f"clear_{edit_step}"
    return END


def _make_clear_node(field: str):
    """Build a tiny node that erases ``field`` so ask_X re-prompts on the
    next loop. Doing this in a separate node keeps the ask_X bodies pure
    (they just check state.get and either skip or interrupt)."""

    async def clear(state: BuildResumeState) -> dict[str, Any]:
        # LangGraph dict reducer is replace-on-update — return field=None.
        # Also wipe the stale _review_decision so the next hitl_review can
        # accept a fresh choice.
        return {field: None, "_review_decision": None}

    clear.__name__ = f"clear_{field}"
    return clear


def build_from_scratch_graph():
    g: StateGraph = StateGraph(BuildResumeState)
    # P2-1 nodes: prefill before any question, clear-nodes for the refine loop.
    g.add_node("prefill", prefill_from_profile)
    g.add_node("ask_target_role", ask_target_role)
    g.add_node("ask_recent_role", ask_recent_role)
    g.add_node("ask_top_3_wins", ask_top_3_wins)
    g.add_node("draft_v1", draft_v1)
    g.add_node("hitl_review", hitl_review)
    g.add_node("clear_target_role", _make_clear_node("target_role"))
    g.add_node("clear_recent_role", _make_clear_node("recent_role"))
    g.add_node("clear_top_3_wins", _make_clear_node("top_3_wins"))

    g.set_entry_point("prefill")
    g.add_edge("prefill", "ask_target_role")
    g.add_edge("ask_target_role", "ask_recent_role")
    g.add_edge("ask_recent_role", "ask_top_3_wins")
    g.add_edge("ask_top_3_wins", "draft_v1")
    g.add_edge("draft_v1", "hitl_review")

    # P2-1: refine loop — hitl_review can route back into a question instead
    # of ending. Each clear_X node nukes one slot then loops to ask_X to
    # collect a new value, then re-runs draft_v1 + hitl_review.
    g.add_conditional_edges(
        "hitl_review",
        _route_after_review,
        {
            "clear_target_role": "clear_target_role",
            "clear_recent_role": "clear_recent_role",
            "clear_top_3_wins": "clear_top_3_wins",
            END: END,
        },
    )
    g.add_edge("clear_target_role", "ask_target_role")
    g.add_edge("clear_recent_role", "ask_recent_role")
    g.add_edge("clear_top_3_wins", "ask_top_3_wins")

    return g.compile(checkpointer=get_checkpointer())


async def start_build_from_scratch(user_id: UUID) -> dict[str, Any]:
    """Public entry called by router.dispatch() — kicks off a new build session.

    Hits ``ask_target_role``'s ``interrupt()`` on first invoke. When this graph
    is executed as a *nested* subgraph (e.g. from the dock_agent ReAct tool
    ``build_resume_from_scratch``), LangGraph raises ``GraphInterrupt`` to the
    caller instead of returning. We catch it and flatten the first question
    into the response so the dock surfaces a real onboarding question instead
    of an opaque tool_error.
    """
    session_id = uuid4()
    thread_id = build_resume_thread_id(str(user_id), str(session_id))
    graph = build_from_scratch_graph()
    config = {"configurable": {"thread_id": thread_id}}
    base: dict[str, Any] = {
        "agent": "coordinator",
        "action": "build_resume",
        "session_id": str(session_id),
        "thread_id": thread_id,
        "status": "awaiting_user_input",
    }
    # Imported locally so an aggressive import-sorter doesn't drop it as
    # "unused" before this except clause is parsed.
    from langgraph.errors import GraphInterrupt

    try:
        await graph.ainvoke({"user_id": user_id}, config=config)
    except GraphInterrupt as gi:
        # `gi.args[0]` is a Sequence[Interrupt]; the first entry holds the
        # value the node passed to interrupt(). Surface it as the dock's
        # next question so the user sees "What role are you going after?"
        # plus chips, not a red ERROR row.
        first = next(iter(gi.args[0]), None) if gi.args else None
        if first is not None and isinstance(getattr(first, "value", None), dict):
            base.update(
                {
                    "question": first.value.get("question"),
                    "step": first.value.get("step"),
                    "chips": first.value.get("chips") or [],
                    "free_form": bool(first.value.get("free_form", True)),
                    "summary": first.value.get("question") or "Starting résumé builder",
                }
            )
        return base
    # Path reached only when the graph completed without interrupting (rare —
    # would mean the workflow finished synchronously). Still a valid response
    # shape for the dock; just no question to ask.
    return base


# ────────────────────────────────────────────────────────────────────────
# prepare_application — delivery loop graph (delivery-loop-plan.md § 3 T3)
# ────────────────────────────────────────────────────────────────────────


async def _parse_jd_node(state: PrepareApplicationState) -> dict[str, Any]:
    """Stage 1: pull JD from URL, structure it, write to jobs table."""
    started = time.perf_counter()
    try:
        result = await jobmatch_agent.parse_jd_from_url(
            state["jd_url"], user_id=state["user_id"], persist=True
        )
    except jobmatch_agent.JDFetchError as exc:
        # Chain-breaker: without a JD the rest of the workflow has nothing
        # to work with. Mark and shortcut to finalize.
        return _stage_failed(state, "parse_jd", str(exc), elapsed_ms_=time.perf_counter() - started)
    stages = dict(state.get("stage_status") or {})
    stages["parse_jd"] = "ok"
    return {
        "job_id": result.job_id,
        "parsed_jd": result.parsed,
        "company": result.company,
        "role_title": result.role_title,
        "stage_status": stages,
        "_stage_timings": {
            **(state.get("_stage_timings") or {}),  # type: ignore[misc]
            "parse_jd_ms": int((time.perf_counter() - started) * 1000),
        },
    }


async def _customize_resume_node(state: PrepareApplicationState) -> dict[str, Any]:
    """Stage 2: tailor base résumé to the parsed JD. Honors fabrication_guard."""
    started = time.perf_counter()
    base = state.get("base_resume_content") or {}
    parsed_jd = state.get("parsed_jd") or {}
    if not base or not parsed_jd:
        return _stage_skipped(state, "customize_resume", "missing_inputs", started)

    job_id = state.get("job_id") or uuid4()  # synthetic when persist hit no DSN
    try:
        result = await resume_agent.customize(
            base_resume=base,
            jd_text=_render_jd_for_customize(parsed_jd, state.get("role_title")),
            user_id=state["user_id"],
            base_version=state.get("base_resume_version", 1),
            base_id=state["base_resume_id"],
            job_id=job_id,
        )
    except Exception as exc:  # noqa: BLE001 — saga catches all
        return _stage_failed(state, "customize_resume", str(exc), elapsed_ms_=time.perf_counter() - started)

    fab_attempts = int(state.get("fabrication_attempts", 0))
    if not result.get("ok"):
        # fabrication_guard refused after 3 tries. Keep base, mark fallback.
        fab_attempts += 3
        stages = dict(state.get("stage_status") or {})
        stages["customize_resume"] = "fallback"
        return {
            "tailored_resume": base,  # fall back to base
            "tailored_resume_id": state["base_resume_id"],
            "stage_status": stages,
            "fabrication_attempts": fab_attempts,
            "_stage_timings": {
                **(state.get("_stage_timings") or {}),  # type: ignore[misc]
                "customize_ms": int((time.perf_counter() - started) * 1000),
            },
        }

    stages = dict(state.get("stage_status") or {})
    stages["customize_resume"] = "ok"
    return {
        "tailored_resume": result.get("tailored"),
        "tailored_resume_id": UUID(result["resume_id"]) if result.get("resume_id") else None,
        "stage_status": stages,
        "fabrication_attempts": fab_attempts,
        "_stage_timings": {
            **(state.get("_stage_timings") or {}),  # type: ignore[misc]
            "customize_ms": int((time.perf_counter() - started) * 1000),
        },
    }


async def _cover_letter_node(state: PrepareApplicationState) -> dict[str, Any]:
    """Stage 3: cover letter. Falls back to a template if LLM/guard fails."""
    started = time.perf_counter()
    tailored = state.get("tailored_resume") or state.get("base_resume_content") or {}
    parsed_jd = state.get("parsed_jd") or {}
    company = state.get("company") or "the company"
    role_title = state.get("role_title") or "this role"
    cover = await appprep_agent.generate_cover_letter(
        tailored_resume=tailored,
        base_resume=state.get("base_resume_content") or tailored,
        parsed_jd=parsed_jd,
        company=company,
        role_title=role_title,
        user_id=state["user_id"],
    )
    stages = dict(state.get("stage_status") or {})
    stages["cover_letter"] = "fallback" if cover.fallback else "ok"
    return {
        "cover_letter": cover.to_dict(),
        "stage_status": stages,
        "_stage_timings": {
            **(state.get("_stage_timings") or {}),  # type: ignore[misc]
            "cover_ms": int((time.perf_counter() - started) * 1000),
        },
    }


async def _form_answers_node(state: PrepareApplicationState) -> dict[str, Any]:
    """Stage 4: ATS form field answers. No-op when no fields were detected."""
    started = time.perf_counter()
    fields = state.get("form_fields") or []
    if not fields:
        stages = dict(state.get("stage_status") or {})
        stages["form_answers"] = "ok"
        return {
            "form_answers": [],
            "stage_status": stages,
            "_stage_timings": {
                **(state.get("_stage_timings") or {}),  # type: ignore[misc]
                "form_ms": 0,
            },
        }

    tailored = state.get("tailored_resume") or state.get("base_resume_content") or {}
    answers = await appprep_agent.generate_form_answers(
        tailored_resume=tailored,
        parsed_jd=state.get("parsed_jd") or {},
        fields=fields,
        user_id=state["user_id"],
    )
    stages = dict(state.get("stage_status") or {})
    skip_ratio = sum(1 for a in answers if a.skip) / max(len(answers), 1)
    stages["form_answers"] = "fallback" if skip_ratio > 0.5 else "ok"
    return {
        "form_answers": [a.to_dict() for a in answers],
        "stage_status": stages,
        "_stage_timings": {
            **(state.get("_stage_timings") or {}),  # type: ignore[misc]
            "form_ms": int((time.perf_counter() - started) * 1000),
        },
    }


def _stage_failed(
    state: PrepareApplicationState,
    stage: str,
    err: str,
    *,
    elapsed_ms_: float,
) -> dict[str, Any]:
    stages = dict(state.get("stage_status") or {})
    stages[stage] = "failed"
    return {
        "stage_status": stages,
        "last_error": f"{stage}: {err}",
        "_stage_timings": {
            **(state.get("_stage_timings") or {}),  # type: ignore[misc]
            f"{stage}_ms": int(elapsed_ms_ * 1000),
        },
    }


def _stage_skipped(
    state: PrepareApplicationState, stage: str, reason: str, started: float
) -> dict[str, Any]:
    stages = dict(state.get("stage_status") or {})
    stages[stage] = "skipped"
    return {
        "stage_status": stages,
        "last_error": f"{stage}: {reason}",
        "_stage_timings": {
            **(state.get("_stage_timings") or {}),  # type: ignore[misc]
            f"{stage.split('_')[0]}_ms": int((time.perf_counter() - started) * 1000),
        },
    }


def _render_jd_for_customize(parsed_jd: dict[str, Any], role: str | None) -> str:
    """Render the parsed JD blob back into text the resume customizer accepts.

    resume_agent.customize takes a flat jd_text — re-flatten the structured
    payload so it can ride the existing prompt rather than spawning a new one.
    """
    parts: list[str] = []
    if role:
        parts.append(f"Role: {role}")
    for key in ("must_haves", "responsibilities", "nice_to_haves", "tech_stack", "skills"):
        items = parsed_jd.get(key) or []
        if items:
            parts.append(f"{key.replace('_', ' ').title()}:")
            parts.extend(f"- {item}" for item in items)
    return "\n".join(parts)


def _branch_after_parse(state: PrepareApplicationState) -> str:
    """Saga: if parse_jd failed we can't proceed — short-circuit to finalize."""
    if (state.get("stage_status") or {}).get("parse_jd") == "failed":
        return "finalize"
    return "customize_resume"


def build_prepare_application_graph():
    """Compose the delivery-loop saga as a LangGraph StateGraph.

    Saga rules (delivery-loop-plan.md § 2.3):
    - parse_jd fails  → skip the rest, finalize with an error stamp
    - customize fails → fall back to base résumé, continue to cover
    - cover fails     → template cover letter, continue to form
    - form fails      → empty form_answers, continue to finalize
    """
    g: StateGraph = StateGraph(PrepareApplicationState)
    g.add_node("parse_jd", _parse_jd_node)
    g.add_node("customize_resume", _customize_resume_node)
    g.add_node("cover_letter", _cover_letter_node)
    g.add_node("form_answers", _form_answers_node)
    g.add_node("finalize", lambda s: {})  # placeholder; finalization happens outside the graph

    g.set_entry_point("parse_jd")
    g.add_conditional_edges("parse_jd", _branch_after_parse, {
        "customize_resume": "customize_resume",
        "finalize": "finalize",
    })
    g.add_edge("customize_resume", "cover_letter")
    g.add_edge("cover_letter", "form_answers")
    g.add_edge("form_answers", "finalize")
    g.add_edge("finalize", END)

    # No checkpointer — prepare_application is a short single-shot workflow
    # invoked from the API layer. State is owned by application_drafts row.
    return g.compile()


async def run_prepare_application(
    *,
    user_id: UUID,
    jd_url: str,
    base_resume_id: UUID,
    base_resume_content: dict[str, Any],
    base_resume_version: int,
    form_fields: list[dict[str, Any]] | None = None,
    application_id: UUID | None = None,
) -> dict[str, Any]:
    """End-to-end driver — runs the graph wrapped in TTAR measurement.

    Returns the final state plus the persisted application_id (creating a
    row in application_drafts upfront so the TTAR write target exists).
    """
    app_id = application_id or await _create_application_draft(
        user_id=user_id, base_resume_id=base_resume_id
    )

    initial: PrepareApplicationState = {
        "user_id": user_id,
        "application_id": app_id,
        "jd_url": jd_url,
        "base_resume_id": base_resume_id,
        "base_resume_content": base_resume_content,
        "base_resume_version": base_resume_version,
        "form_fields": form_fields or [],
        "fabrication_attempts": 0,
        "stage_status": {},
        "_stage_timings": {},  # type: ignore[typeddict-unknown-key]
    }

    graph = build_prepare_application_graph()
    async with measure_ttar(app_id) as ttar:
        final_state = await graph.ainvoke(initial, config={"recursion_limit": 25})
        # Push per-stage timings the nodes recorded in state into the TTAR record.
        for stage, ms in (final_state.get("_stage_timings") or {}).items():
            ttar.stage(stage, int(ms))
        ttar.fabrication_attempts = int(final_state.get("fabrication_attempts", 0))
        stage_status = final_state.get("stage_status") or {}
        ttar.success = (
            stage_status.get("parse_jd") == "ok"
            and stage_status.get("customize_resume") in ("ok", "fallback")
            and bool(final_state.get("cover_letter"))
        )
        # Persist the workflow outputs back to the application_drafts row.
        await _patch_application_draft(
            app_id,
            tailored_resume_id=final_state.get("tailored_resume_id"),
            cover_letter=(final_state.get("cover_letter") or {}).get("body"),
            form_answers=final_state.get("form_answers"),
            status="review" if ttar.success else "draft",
        )

    return {
        "application_id": str(app_id),
        "status": "review" if (final_state.get("stage_status") or {}).get("parse_jd") == "ok" else "draft",
        "stage_status": final_state.get("stage_status") or {},
        "cover_letter": final_state.get("cover_letter"),
        "form_answers": final_state.get("form_answers"),
        "tailored_resume_id": (
            str(final_state["tailored_resume_id"]) if final_state.get("tailored_resume_id") else None
        ),
        "company": final_state.get("company"),
        "role_title": final_state.get("role_title"),
        "last_error": final_state.get("last_error"),
    }


async def _create_application_draft(*, user_id: UUID, base_resume_id: UUID) -> UUID:
    """INSERT a draft row so the TTAR write target exists; no-op without DSN."""
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return uuid4()  # synthetic id for hermetic tests
    try:
        import psycopg
    except ImportError:
        return uuid4()
    sql = (
        "INSERT INTO application_drafts (user_id, job_id, resume_version_id, status) "
        "VALUES (%s, gen_random_uuid(), %s, 'draft') "
        "RETURNING id"
    )
    # job_id is NOT NULL on the table; we don't know the real one yet, so use
    # a placeholder UUID. parse_jd_node will UPDATE it in a later refactor;
    # for now this row is the TTAR sink, the linked job is in jobs table.
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, (str(user_id), str(base_resume_id)))
                row = await cur.fetchone()
            await conn.commit()
        return row[0] if row else uuid4()
    except Exception:  # noqa: BLE001 boundary
        return uuid4()


async def _patch_application_draft(
    application_id: UUID,
    *,
    tailored_resume_id: UUID | None,
    cover_letter: str | None,
    form_answers: list[dict] | None,
    status: str,
) -> None:
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return
    try:
        import psycopg
    except ImportError:
        return
    import json as _json

    sql = (
        "UPDATE application_drafts "
        "   SET resume_version_id = COALESCE(%s, resume_version_id), "
        "       cover_letter = COALESCE(%s, cover_letter), "
        "       form_answers = COALESCE(%s::jsonb, form_answers), "
        "       status = %s, "
        "       updated_at = now() "
        " WHERE id = %s"
    )
    params = (
        str(tailored_resume_id) if tailored_resume_id else None,
        cover_letter,
        _json.dumps(form_answers) if form_answers is not None else None,
        status,
        str(application_id),
    )
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
            await conn.commit()
    except Exception:  # noqa: BLE001 boundary
        return
