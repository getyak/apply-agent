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
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel, Field, field_validator

from agents.api.deps import UserDep
from agents.coordinator.router import classify_intent, dispatch, persist_turn
from agents.coordinator.workflows import build_from_scratch_graph
from agents.harness.checkpointer import (
    ask_vantage_thread_id,
    get_checkpointer,
    mock_thread_id,
)
from agents.harness.guards import BudgetExhausted
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


# ─────────────────────────────────────────────────────────────────────────
# Global error envelope (round-5)
#
# Round-5 audit flagged two problems with how this layer reports errors:
#   API1: no global exception handler — uncaught exceptions surface as
#         FastAPI's default {"detail": "Internal Server Error"} with no
#         trace_id, making prod debugging a guessing game.
#   API2: SSE error frames embed the raw `str(exc)` text, leaking internal
#         stack details (file paths, "session cost 12.4567c > 50.0c", etc.)
#         and giving the frontend no machine-readable code to act on.
#
# These handlers + _error_envelope() centralise the shape (`code`, `message`,
# `trace_id`) and choose a user-safe message per exception category. The SSE
# error path uses the same helper so the dock and the JSON envelopes stay in
# sync — one place to localise, one shape for the frontend to match.
# ─────────────────────────────────────────────────────────────────────────


def _error_envelope(exc: BaseException, trace_id: str) -> dict[str, Any]:
    """Map an exception to a sanitized {code, message, trace_id} envelope.

    The message must be safe to show end-users: no file paths, no balance
    digits, no internal field names. The log line (caller's responsibility)
    keeps the raw text for support to correlate via trace_id.
    """
    if isinstance(exc, BudgetExhausted):
        # CostGuard hit — translatable copy, no "12.34c > 50.0c" detail.
        return {
            "code": "budget_exhausted",
            "message": "Your session budget is used up. Try again later or contact support.",
            "trace_id": trace_id,
        }
    if isinstance(exc, HTTPException):
        # FastAPI's own 4xx — keep the upstream detail (it's already
        # author-controlled in our routes) but normalise the shape.
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return {
            "code": f"http_{exc.status_code}",
            "message": detail,
            "trace_id": trace_id,
        }
    # Catch-all — never leak str(exc). Support reads the log via trace_id.
    return {
        "code": "internal_error",
        "message": "Something went wrong on our side. We've logged this — please retry shortly.",
        "trace_id": trace_id,
    }


@app.exception_handler(HTTPException)
async def _http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    trace_id = uuid4().hex
    log.warning("http_exception", trace_id=trace_id, status=exc.status_code, detail=str(exc.detail))
    return JSONResponse(
        status_code=exc.status_code,
        content=_error_envelope(exc, trace_id),
        headers={"X-Trace-Id": trace_id},
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    trace_id = uuid4().hex
    # Log the full exception text so support can correlate; the response body
    # only carries the sanitized envelope.
    log.error("unhandled_exception", trace_id=trace_id, error=str(exc), kind=type(exc).__name__)
    status = 402 if isinstance(exc, BudgetExhausted) else 500
    return JSONResponse(
        status_code=status,
        content=_error_envelope(exc, trace_id),
        headers={"X-Trace-Id": trace_id},
    )


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
    x_request_id: Annotated[str | None, Header()] = None,
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
    # OBS3 (round-12): bind the gateway-issued request id to structlog so
    # every subsequent log line in this turn carries it. The round-12
    # observability audit pointed out that Python logs were context-free
    # w.r.t. the originating request — a 5xx in agent_tasks could not be
    # traced back to the browser-visible X-Request-Id. structlog's
    # contextvars-based binding scopes the override to the current
    # asyncio task so concurrent requests don't cross-contaminate.
    if x_request_id:
        structlog.contextvars.bind_contextvars(request_id=x_request_id)
    log.info(
        "ask_stream.start",
        thread_id=thread_id,
        surface=surface,
        request_id=x_request_id,
    )

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
            # round-5 API2: stop leaking raw str(exc) into the SSE error
            # frame. Reuse the same envelope helper the JSON handlers do, so
            # the dock can branch on `code` (budget_exhausted, http_403,
            # internal_error, …) and we have a single trace_id to grep for
            # when a user reports the error.
            trace_id = uuid4().hex
            log.error(
                "ask_stream.dispatch_failed",
                trace_id=trace_id,
                error=str(exc),
                kind=type(exc).__name__,
            )
            envelope = _error_envelope(exc, trace_id)
            yield _sse({"event": "error", **envelope})

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

    # version is assigned atomically by migration 016's trigger — no
    # app-level SELECT MAX(version)+1 race.
    new_id, assigned_v = await save_resume_version(
        user_id=user_id,
        content_json=parsed,
        parent_version_id=None,
        tailored_for_job=None,
        is_base=True,
    )
    return {"resume_id": str(new_id), "version": assigned_v, "parsed": parsed}


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
    # HITL_R3 (round-8): the round-8 audit flagged that thread_id and
    # answer were untyped beyond `str`, leaving the door open for an
    # attacker (or a buggy client) to POST a 10 MB string and crash
    # downstream consumers via RecursionError in json.dumps. The thread
    # cap is 128 because the longest legitimate value today is
    # `build_resume:{uuid4}:{uuid4}` (~57 chars) — generous headroom
    # without inviting abuse. The answer cap is 50 000 chars: ~10 000
    # words of actual prose, far beyond what any honest interview answer
    # needs, while still well below the body-size limit the gateway
    # enforces upstream.
    thread_id: str = Field(min_length=1, max_length=128)
    answer: str = Field(min_length=1, max_length=50_000)


@app.post("/mock/resume")
async def mock_resume(payload: MockResumePayload, user_id: UserDep) -> dict[str, Any]:
    """User submitted an answer → resume the graph past await_user_input."""
    config = {"configurable": {"thread_id": payload.thread_id}}
    checkpointer = get_checkpointer()
    # Recover mode from the persisted state to rebuild the same graph.
    snapshot = checkpointer.get(config)
    if not snapshot:
        raise HTTPException(status_code=404, detail="thread not found")
    # HITL_R4 (round-8): the round-8 HITL audit flagged that this endpoint
    # would happily resume any thread_id whose checkpoint we could load,
    # without verifying the auth'd user owned it. An attacker who learnt
    # another user's mock thread_id (e.g. accidentally leaked in a log)
    # could replay an answer on the victim's session. Cross-check the
    # state's stored user_id against the auth-resolved one and return 403
    # on mismatch. Both UUID and str representations are accepted because
    # different code paths may persist either.
    stored_user = snapshot["channel_values"].get("user_id")  # type: ignore[index]
    if str(stored_user) != str(user_id):
        log.warning(
            "mock_resume.user_mismatch",
            thread_id=payload.thread_id,
            requested_by=str(user_id),
            stored_owner=str(stored_user),
        )
        raise HTTPException(status_code=403, detail="thread is not yours")
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
    # HITL_R3 (round-8): build_resume's `value` field used to be
    # `Any`, accepting nested dicts, circular references, and arbitrary
    # binary blobs. The audit pointed out this is a prompt-injection vector
    # since the value lands in a chip's string state and is then fed to
    # downstream LLM calls. Constrain to the two shapes the workflow
    # actually consumes: a single string (target_role, recent_role) or a
    # list of strings (top_3_wins). Caps mirror the MockResumePayload sizes
    # so the same body-size envelope holds across both /resume endpoints.
    thread_id: str = Field(min_length=1, max_length=128)
    value: str | list[str] = Field(...)

    @field_validator("value")
    @classmethod
    def _bound_value(cls, v: str | list[str]) -> str | list[str]:
        if isinstance(v, str):
            if len(v) > 10_000:
                raise ValueError("value string exceeds 10000 characters")
            return v
        # list[str]
        if len(v) > 50:
            raise ValueError("value list exceeds 50 items")
        for i, item in enumerate(v):
            if not isinstance(item, str):
                raise ValueError(f"value[{i}] is not a string")
            if len(item) > 2_000:
                raise ValueError(f"value[{i}] exceeds 2000 characters")
        return v


@app.post("/build_resume/resume")
async def build_resume_resume(payload: BuildResumeResumePayload, user_id: UserDep) -> dict[str, Any]:
    # HITL_R4 (round-8): the build_resume thread_id is structured as
    # `build_resume:{user_id}:{session_id}` (see checkpointer.py); we can
    # verify ownership cheaply by parsing the embedded user_id. The audit
    # showed the prior version would resume any thread the caller named,
    # opening an IDOR vector — an attacker who guessed a victim's
    # session_id could nudge the workflow past an interrupt. The parse is
    # tolerant: any thread_id that doesn't match the expected shape is
    # rejected outright (403) so future thread_id changes can't silently
    # bypass this check.
    parts = payload.thread_id.split(":")
    if len(parts) != 3 or parts[0] != "build_resume" or parts[1] != str(user_id):
        log.warning(
            "build_resume_resume.user_mismatch",
            thread_id=payload.thread_id,
            requested_by=str(user_id),
        )
        raise HTTPException(status_code=403, detail="thread is not yours")
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
