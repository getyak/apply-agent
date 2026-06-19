"""FastAPI agent layer entry point.

Exposes three core endpoints for the Vantage UI:
  POST /ask/stream        — SSE Ask Vantage dock conversation
  POST /mock/start        — start a Mock session (returns thread_id + first interrupt)
  POST /mock/resume       — resume Mock after user answers (Command(resume=...))
  POST /resume/upload     — parse + persist a new base résumé (bypasses dock)
  POST /resume/customize  — direct tailor endpoint (called by Bun gateway when dock routes here)
  POST /build_resume/resume — resume a build_from_scratch step (chip answer)
  GET  /healthz           — liveness
  GET  /modes             — list built-in + user-custom modes

Caller: Bun api/ layer proxies user requests here over HTTP.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Annotated, Any
from uuid import UUID, uuid4

import structlog
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel

from agents.api.deps import UserDep
from agents.coordinator.router import classify_intent, dispatch, persist_turn
from agents.coordinator.workflows import build_from_scratch_graph
from agents.harness.checkpointer import (
    ask_vantage_thread_id,
    get_checkpointer,
    mock_thread_id,
)
from agents.harness.state import InterviewMode
from agents.nodes import interview_agent, resume_agent
from agents.tools.auto import pg_query

log = structlog.get_logger("agents.api")


# Lifespan: start the application:submitted consumers in the background so the
# T8 flywheel plumbing exists from boot. They are log-only today and tolerate
# a missing Redis (subscribe() returns silently), so wiring this in carries
# zero risk in dev / hermetic CI.
from contextlib import asynccontextmanager  # noqa: E402 — needs `app` below


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    from agents.events.consumers import start_in_background

    task = start_in_background()
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except BaseException:
            pass  # noqa: BLE001 — clean shutdown path


app = FastAPI(title="Relay Agents", version="0.1.0", lifespan=_lifespan)


# ───────────────────────────────────────────────────────────────────────
# Health
# ───────────────────────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ───────────────────────────────────────────────────────────────────────
# Modes catalogue
# ───────────────────────────────────────────────────────────────────────


@app.get("/modes")
async def list_modes(user_id: UserDep) -> dict[str, list[dict[str, Any]]]:
    """Return built-in + this user's custom modes, ready for the Mode Gallery."""
    rows = await pg_query(
        """
        SELECT id, slug, display_name, description,
               intel_strategy, pressure_level, feedback_style, loop_behavior,
               is_built_in
        FROM interview_modes
        WHERE NOT is_archived AND (user_id IS NULL OR user_id = %s)
        ORDER BY is_built_in DESC, created_at ASC
        """,
        (str(user_id),),
    )
    return {"modes": [dict(r) for r in rows]}


# ───────────────────────────────────────────────────────────────────────
# Ask Vantage
# ───────────────────────────────────────────────────────────────────────


class AskPayload(BaseModel):
    message: str


@app.post("/ask/stream")
async def ask_stream(
    payload: AskPayload,
    user_id: UserDep,
    x_relay_thread_id: Annotated[str | None, Header()] = None,
    x_relay_surface: Annotated[str | None, Header()] = None,
) -> StreamingResponse:
    """SSE stream — classifies intent, runs the dispatched agent, emits task cards.

    Two conversation channels share this endpoint (vantage-ui-mapping.md
    §2.6): the dock (lifetime per-user thread) and the document-scoped vibe
    chats (resume_studio, mock_studio, applications). The web layer picks
    the right thread id, sends it as ``X-Relay-Thread-Id``, and labels the
    surface via ``X-Relay-Surface`` so the router can adjust context loading
    if it needs to. A missing thread header falls back to the dock thread —
    matches old curl behaviour.
    """
    thread_id = x_relay_thread_id or ask_vantage_thread_id(str(user_id))
    # surface is informational today (we trust the gateway's thread id);
    # logged for observability and reserved for future per-surface context
    # tuning in the router.
    surface = (x_relay_surface or "dock").lower()
    log.info("ask_stream.start", thread_id=thread_id, surface=surface)

    async def gen() -> AsyncIterator[str]:
        yield _sse({"event": "thinking", "agent": "coordinator"})

        intent = await classify_intent(payload.message)
        yield _sse(
            {
                "event": "intent",
                "intent": intent.intent,
                "confidence": intent.confidence,
                "via": intent.via,
                "args": intent.args,
            }
        )

        try:
            result = await dispatch(
                intent,
                user_id=user_id,
                message=payload.message,
                thread_id=thread_id,
                surface=surface,
            )
            yield _sse({"event": "result", **result})
            # Persist the turn so the next dock prompt has context.
            await persist_turn(
                thread_id=thread_id,
                user_id=user_id,
                user_message=payload.message,
                assistant_text=_result_summary(result),
            )
        except Exception as exc:  # noqa: BLE001 boundary
            log.error("ask_stream.dispatch_failed", error=str(exc))
            yield _sse({"event": "error", "message": str(exc)})

        yield _sse({"event": "done"})

    return StreamingResponse(gen(), media_type="text/event-stream")


def _result_summary(result: dict[str, Any]) -> str:
    """Compact human-readable summary of a dispatch result for the turn log."""
    text = result.get("text")
    if isinstance(text, str) and text:
        return text
    agent = result.get("agent", "coordinator")
    action = result.get("action", "")
    return f"[{agent} → {action}]".strip()


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, default=str)}\n\n"


# ───────────────────────────────────────────────────────────────────────
# Résumé
# ───────────────────────────────────────────────────────────────────────


class ResumeUploadPayload(BaseModel):
    raw_text: str


@app.post("/resume/upload")
async def resume_upload(payload: ResumeUploadPayload, user_id: UserDep) -> dict[str, Any]:
    """Parse raw text into JSON Resume and persist as a new base version."""
    parsed = await resume_agent.parse(payload.raw_text, user_id=user_id)
    if not parsed:
        raise HTTPException(status_code=422, detail="couldn't parse résumé")

    from agents.tools.notify import save_resume_version

    # Compute next version number for this user.
    rows = await pg_query(
        "SELECT COALESCE(MAX(version), 0) AS v FROM resumes WHERE user_id = %s",
        (str(user_id),),
    )
    next_v = int(rows[0]["v"]) + 1 if rows else 1
    new_id = await save_resume_version(
        user_id=user_id,
        version=next_v,
        content_json=parsed,
        parent_version_id=None,
        tailored_for_job=None,
        is_base=True,
    )
    return {"resume_id": str(new_id), "version": next_v, "parsed": parsed}


class ResumeCustomizePayload(BaseModel):
    base_resume_id: UUID
    base_version: int
    base_resume_content: dict[str, Any]
    job_id: UUID
    jd_text: str


@app.post("/resume/customize")
async def resume_customize(payload: ResumeCustomizePayload, user_id: UserDep) -> dict[str, Any]:
    result = await resume_agent.customize(
        base_resume=payload.base_resume_content,
        jd_text=payload.jd_text,
        user_id=user_id,
        base_version=payload.base_version,
        base_id=payload.base_resume_id,
        job_id=payload.job_id,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    return result


# ───────────────────────────────────────────────────────────────────────
# Applications — delivery loop (docs/architecture/delivery-loop-plan.md)
# ───────────────────────────────────────────────────────────────────────


class PrepareApplicationPayload(BaseModel):
    jd_url: str
    base_resume_id: UUID
    base_resume_content: dict[str, Any]
    base_resume_version: int = 1
    form_fields: list[dict[str, Any]] = []  # ATS field descriptors; may be empty
    application_id: UUID | None = None       # idempotency: reuse a draft row


@app.post("/applications/prepare")
async def applications_prepare(
    payload: PrepareApplicationPayload, user_id: UserDep
) -> dict[str, Any]:
    """Run the full delivery-loop saga and return everything the UI needs.

    Drives TTAR (delivery-loop-plan.md § 1). Stage-level fallbacks live in
    workflows.run_prepare_application — this endpoint just shapes the
    response and surfaces the TTAR-relevant fields.
    """
    from agents.coordinator.workflows import run_prepare_application

    return await run_prepare_application(
        user_id=user_id,
        jd_url=payload.jd_url,
        base_resume_id=payload.base_resume_id,
        base_resume_content=payload.base_resume_content,
        base_resume_version=payload.base_resume_version,
        form_fields=payload.form_fields,
        application_id=payload.application_id,
    )


class ApplicationSubmittedPayload(BaseModel):
    """Posted by the extension after the user clicks the ATS Submit button.

    Body shape stays minimal — anything the consumers need is queryable from
    the application_drafts / jobs tables given the id. We keep `company` /
    `role_title` in the event itself so log-only consumers (T8 phase 1) have
    something readable without doing a JOIN.
    """

    company: str | None = None
    role_title: str | None = None
    submitted_via: str = "client_extension"


@app.post("/applications/{application_id}/submitted")
async def applications_submitted(
    application_id: UUID,
    payload: ApplicationSubmittedPayload,
    user_id: UserDep,
) -> dict[str, Any]:
    """Mark an application as submitted + emit application:submitted event.

    Flywheel pre-wiring (delivery-loop-plan.md § 2.1 + T8). The event powers
    the interview_agent_preheat / trend_agent_signal consumers wired in
    agents/events/consumers.py.

    DB write is best-effort (it's how we transition status=submitted) but
    the event fire is the real product surface — if PG is down for some
    reason we still emit so the consumers see the submit.
    """
    from agents.events.bus import publish
    from agents.tools.auto import pg_query

    # Best-effort DB update — drop the application into 'submitted' state
    # and stamp submitted_at. If the row is owned by another user we
    # silently no-op (don't leak existence).
    try:
        await pg_query(
            "UPDATE application_drafts "
            "   SET status = 'submitted', "
            "       submitted_at = COALESCE(submitted_at, now()), "
            "       submitted_via = COALESCE(submitted_via, %s), "
            "       updated_at = now() "
            " WHERE id = %s AND user_id = %s",
            (payload.submitted_via, str(application_id), str(user_id)),
        )
    except Exception as exc:  # noqa: BLE001 boundary
        log.warning("applications.submitted.db_write_failed", error=str(exc))

    entry_id = await publish(
        "application:submitted",
        {
            "user_id": str(user_id),
            "application_id": str(application_id),
            "company": payload.company,
            "role_title": payload.role_title,
            "submitted_via": payload.submitted_via,
        },
    )
    return {"ok": True, "event_id": entry_id, "application_id": str(application_id)}


# ───────────────────────────────────────────────────────────────────────
# Extension — cloud field mapping (delivery-loop-plan.md § 3 T7)
# ───────────────────────────────────────────────────────────────────────


class ExtensionMapFieldsPayload(BaseModel):
    """Subset of CloudFillRequest from apps/extension/src/cloud-fill.ts."""

    context: dict[str, Any]  # ATSContext shape, but we only read jdUrl + source
    jd_url: str
    fields: list[dict[str, Any]]  # DetectedField[] from the extension

    # pydantic v2: accept both camelCase from the extension and snake_case.
    model_config = {"populate_by_name": True}


@app.post("/extension/map-fields")
async def extension_map_fields(
    payload: ExtensionMapFieldsPayload, user_id: UserDep
) -> dict[str, Any]:
    """Map ATS form fields the local filler couldn't handle.

    Drives the "+25% fields" half of docs/architecture/client-side-delivery.md
    plan B. The extension calls this with whatever planLocalFill() left as
    `unmatched`; we look up the user's base résumé, fetch the parsed JD via
    jobmatch_agent, and hand both to appprep_agent.generate_form_answers.

    Returned shape matches CloudFillResponse:
      {
        "fills":     [{ selector, profileKey, value, type, confidence }, ...],
        "unmatched": [DetectedField, ...]   // fields the model declined / skipped
      }
    """
    from agents.nodes import appprep_agent, jobmatch_agent
    from agents.tools.auto import pg_query

    if not payload.fields:
        return {"fills": [], "unmatched": []}

    # 1. Look up the user's base résumé. Without one we have nothing to
    #    ground answers in; degrade rather than crash.
    rows = await pg_query(
        "SELECT content FROM resumes "
        "WHERE user_id = %s AND is_base = TRUE "
        "ORDER BY version DESC LIMIT 1",
        (str(user_id),),
    )
    if not rows:
        # No base résumé → return all fields as unmatched so the user fills
        # them manually. Don't 422 — the extension would just look broken.
        return {"fills": [], "unmatched": payload.fields}

    base_resume = rows[0]["content"]
    if isinstance(base_resume, str):
        import json as _json

        base_resume = _json.loads(base_resume)

    # 2. Parse the JD (cached UPSERT — cheap when the same job has been
    #    seen before).
    try:
        parsed = await jobmatch_agent.parse_jd_from_url(
            payload.jd_url, user_id=user_id, persist=True
        )
        parsed_jd = parsed.parsed
    except jobmatch_agent.JDFetchError:
        parsed_jd = {}

    # 3. Ask AppPrep for answers per field.
    answers = await appprep_agent.generate_form_answers(
        tailored_resume=base_resume,
        parsed_jd=parsed_jd,
        fields=payload.fields,
        user_id=user_id,
    )

    # 4. Convert FormFieldAnswer → FillInstruction (or unmatched).
    fields_by_id = {str(f.get("id") or ""): f for f in payload.fields}
    fills: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    for ans in answers:
        f = fields_by_id.get(ans.id)
        if ans.skip or not ans.answer or not f:
            if f:
                unmatched.append(f)
            continue
        fills.append(
            {
                "selector": f.get("selector", ""),
                "profileKey": "cloud_llm",  # extension uses this only for highlight metadata
                "value": ans.answer,
                "type": f.get("type", "text"),
                "confidence": ans.confidence,
            }
        )

    return {"fills": fills, "unmatched": unmatched}


# ───────────────────────────────────────────────────────────────────────
# Mock
# ───────────────────────────────────────────────────────────────────────


class MockStartPayload(BaseModel):
    mode_slug: str
    company: str | None = None
    role: str | None = None
    round_type: str | None = None


@app.post("/mock/start")
async def mock_start(payload: MockStartPayload, user_id: UserDep) -> dict[str, Any]:
    """Boot a new Mock session. The graph runs until the first interrupt()
    (await_user_input on Q1) and returns that to the client."""
    mode = await interview_agent.load_mode(payload.mode_slug, user_id=user_id)
    if not mode:
        raise HTTPException(status_code=404, detail=f"mode '{payload.mode_slug}' not found")

    session_id = uuid4()

    # Create the interview_sessions row so save_to_card can UPDATE later.
    await _create_session_row(user_id=user_id, session_id=session_id, mode_id=mode["id"], company=payload.company)

    graph = interview_agent.build_mock_graph(mode)
    config = {"configurable": {"thread_id": mock_thread_id(str(session_id))}}
    initial_state = {
        "user_id": user_id,
        "session_id": session_id,
        "mode": mode,
        "company": payload.company,
        "role": payload.role,
        "round_type": payload.round_type,
    }
    state = await graph.ainvoke(initial_state, config=config)

    # Surface the pending interrupt (the question awaiting an answer).
    pending_q = state.get("_pending_question")
    intel = state.get("intel")
    return {
        "session_id": str(session_id),
        "thread_id": mock_thread_id(str(session_id)),
        "intel": intel,
        "current_question": pending_q,
    }


class MockResumePayload(BaseModel):
    thread_id: str
    answer: str


@app.post("/mock/resume")
async def mock_resume(payload: MockResumePayload, user_id: UserDep) -> dict[str, Any]:
    """User submitted an answer → resume the graph past await_user_input."""
    config = {"configurable": {"thread_id": payload.thread_id}}
    checkpointer = get_checkpointer()
    # Recover mode from the persisted state to rebuild the same graph.
    snapshot = checkpointer.get(config)
    if not snapshot:
        raise HTTPException(status_code=404, detail="thread not found")
    mode: InterviewMode = snapshot["channel_values"]["mode"]  # type: ignore[index]
    graph = interview_agent.build_mock_graph(mode)
    state = await graph.ainvoke(Command(resume={"answer": payload.answer}), config=config)
    return {
        "current_question": state.get("_pending_question"),
        "last_feedback": state.get("last_feedback"),
        "weak_points": state.get("weak_points", []),
        "questions_asked": state.get("questions_asked", 0),
        "save_result": state.get("_save_result"),
    }


# ───────────────────────────────────────────────────────────────────────
# Build-resume workflow resume
# ───────────────────────────────────────────────────────────────────────


class BuildResumeResumePayload(BaseModel):
    thread_id: str
    value: Any  # str | list[str]


@app.post("/build_resume/resume")
async def build_resume_resume(payload: BuildResumeResumePayload, user_id: UserDep) -> dict[str, Any]:
    graph = build_from_scratch_graph()
    config = {"configurable": {"thread_id": payload.thread_id}}
    state = await graph.ainvoke(Command(resume={"value": payload.value}), config=config)
    return {
        "target_role": state.get("target_role"),
        "recent_role": state.get("recent_role"),
        "top_3_wins": state.get("top_3_wins"),
        "draft_resume_id": str(state.get("draft_resume_id") or ""),
        "review_decision": state.get("_review_decision"),
    }


# ───────────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────────


async def _create_session_row(user_id: UUID, session_id: UUID, mode_id: UUID, company: str | None) -> None:
    import os

    import psycopg

    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return
    sql = """
        INSERT INTO interview_sessions (id, user_id, mode_id, interview_type, stage)
        VALUES (%s, %s, %s, 'mock', NULL)
    """
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, (str(session_id), str(user_id), str(mode_id)))
        await conn.commit()
