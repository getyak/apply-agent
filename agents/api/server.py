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

import asyncio  # used by _with_heartbeat (round-12 SSE ping)
import json

# Load the repo-root .env BEFORE any agents.* import so OPENROUTER_API_KEY /
# DATABASE_URL / REDIS_URL are present in os.environ. The agents layer reads
# config purely via os.environ (harness/llm.py), so without this the key is
# silently None and every LLM call fails with "reasoning engine returned an
# error". Real env vars injected by the deploy win (override=False).
import os  # noqa: E402
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

# Strip inherited shell proxy vars before any httpx client is constructed.
# Why: when the developer's shell exports `all_proxy=socks5://...` (common on
# macOS with Clash / Surge / V2Ray), httpx auto-discovers it and tries to
# build a SOCKS transport — which requires the optional `socksio` package.
# Without socksio, `ChatOpenAI(...)` raises ImportError at construction time
# and the Bun gateway surfaces it as "Vantage's reasoning engine returned an
# error". OpenRouter is on the public internet via HTTPS; the dev's local
# proxy must not sit between agents and OpenRouter. Honor an explicit
# OPENROUTER_PROXY escape hatch for users who deliberately need to route
# through a proxy (they should also install httpx[socks]).
if not os.environ.get("OPENROUTER_PROXY"):
    for _p in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        os.environ.pop(_p, None)

import structlog  # noqa: E402
from fastapi import FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402
from langgraph.types import Command  # noqa: E402
from pydantic import BaseModel, Field, field_validator  # noqa: E402

from agents.api.deps import UserDep  # noqa: E402
from agents.coordinator.router import (  # noqa: E402
    cheap_intent_classifier,
    classify_intent,
    dispatch,
    persist_turn,
)
from agents.coordinator.workflows import build_from_scratch_graph  # noqa: E402

# Sprint 1 of docs/design/chat-agent-system-redesign.md: when the env flag is
# set, the LLM-fallback branch of /ask/stream is delegated to the new Dock
# ReAct agent (P0-A). The regex fast path stays as-is so confident command-
# like prompts ("list applications", "mock me on Stripe") never pay the
# main-loop LLM tax. Default OFF so the rollout is opt-in until we're happy.
_DOCK_REACT_ENABLED = os.environ.get("RELAY_DOCK_REACT", "0") == "1"
# Threshold for skipping the dock and going straight to dispatch on a cheap
# regex hit.
#
# P3-1 fix: lowered default from 0.95 → 0.85. The earlier audit found that
# turning _DOCK_REACT_ENABLED on with a 0.95 cutoff silently lost 5 intents
# (analyze_resume / optimize_resume / map_career_moves / surface_roles /
# list_resume_versions) whose regex confidences sit in 0.85–0.92 — they
# wouldn't fast-path AND they have no dock_tool wrapper, so they fell into
# the dock LLM as free-form turns. 0.85 matches router.REGEX_ACCEPT_THRESHOLD,
# so every regex-confident intent now goes straight to dispatch via the same
# rule. Override with RELAY_DOCK_FAST_PATH to be stricter / looser per env.
_DOCK_REGEX_FAST_PATH_THRESHOLD = float(os.environ.get("RELAY_DOCK_FAST_PATH", "0.85"))
from agents.harness.audit import redact_exception_text  # noqa: E402
from agents.harness.checkpointer import (  # noqa: E402
    ask_vantage_thread_id,
    get_checkpointer,
    mock_thread_id,
)
from agents.harness.guards import BudgetExhausted  # noqa: E402
from agents.harness.state import InterviewMode  # noqa: E402
from agents.nodes import interview_agent, resume_agent  # noqa: E402
from agents.tools.auto import pg_query  # noqa: E402

log = structlog.get_logger("agents.api")


# Lifespan: start the application:submitted consumers in the background so the
# T8 flywheel plumbing exists from boot. They are log-only today and tolerate
# a missing Redis (subscribe() returns silently), so wiring this in carries
# zero risk in dev / hermetic CI.
from contextlib import asynccontextmanager  # noqa: E402 — needs `app` below


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # P1-5: launch all cross-agent consumers in the background.
    # application:submitted + resume:updated + resume:tailored + flywheel.
    from agents.events.consumers import start_all_in_background

    tasks = start_all_in_background()
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except BaseException:
                pass  # noqa: BLE001 — clean shutdown path


app = FastAPI(title="Relay Agents", version="0.1.0", lifespan=_lifespan)


# ─────────────────────────────────────────────────────────────────────────
# Error envelope v2 — aligned with the gateway (api/src/errors.ts) so the
# web layer parses ONE shape regardless of which layer emitted the error.
# See docs/architecture/error-handling.md §2.1.
#
# Two upgrades over the round-5 envelope:
#   1. Trace propagation: we honour an inbound X-Trace-Id (the gateway sets
#      it via api/src/middleware/trace-id.ts) instead of minting a fresh
#      id per exception — so all three layers' logs share one id.
#   2. Full v2 shape: {code, message, messageKey, traceId, traceCode,
#      requestId, timestamp, details, action}. Codes match the
#      ErrorCode taxonomy in §3.1 so the web error router (resolve.ts)
#      can branch on the same string the gateway emits.
# ─────────────────────────────────────────────────────────────────────────

from datetime import UTC, datetime  # noqa: E402

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _trace_code_from(trace_id: str) -> str:
    """Mirror of api/src/errors.ts traceCodeFromTraceId.
    Same input → same R-XXXX so support gets one ref regardless of layer.
    """
    hex_ = trace_id.replace("-", "")[:10]
    if len(hex_) < 10:
        return "R-0000"
    try:
        high = int(hex_[0:5], 16)
        low = int(hex_[5:10], 16)
    except ValueError:
        return "R-0000"
    folded = high ^ low
    out = ""
    n = folded
    for _ in range(4):
        out = _CROCKFORD[n & 0x1F] + out
        n >>= 5
    return f"R-{out}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Inbound trace id is plumbed through request.state; the middleware below
# sets it from the X-Trace-Id header or mints a UUID. We deliberately use a
# UUID (not bare hex) so the web layer's deterministic traceCode hashing
# matches what the gateway uses for the same id.
def _trace_for(request: Request | None) -> str:
    if request is not None:
        tid = getattr(request.state, "trace_id", None)
        if isinstance(tid, str) and tid:
            return tid
    return str(uuid4())


def _request_id_for(request: Request | None) -> str | None:
    if request is None:
        return None
    rid = getattr(request.state, "request_id", None)
    if isinstance(rid, str) and rid:
        return rid
    return None


def _http_status_code(status_code: int) -> str:
    """Map a bare HTTP status to the v2 ErrorCode dictionary."""
    return {
        400: "VALIDATION_FAILED",
        401: "AUTH_REQUIRED",
        402: "LLM_BUDGET_EXHAUSTED",
        403: "AUTH_FORBIDDEN",
        404: "RESOURCE_NOT_FOUND",
        409: "RESOURCE_CONFLICT",
        410: "RESOURCE_GONE",
        413: "VALIDATION_FAILED",
        422: "VALIDATION_FAILED",
        429: "RATE_LIMITED",
        500: "INTERNAL",
        502: "UPSTREAM_UNAVAILABLE",
        503: "UPSTREAM_UNAVAILABLE",
        504: "UPSTREAM_TIMEOUT",
    }.get(status_code, "INTERNAL")


# Map the `reason` strings node code returns when it can't proceed onto v2
# envelope fields. Keeping this table here (next to the envelope builder)
# means routes can keep raising `HTTPException(detail={"ok": False, "reason":
# ...})` without having to know the v2 catalog — error-handling.md §3 stays
# the single source of truth for which codes exist.
_REASON_TO_ENVELOPE: dict[str, dict[str, Any]] = {
    "fabrication_guard_failed": {
        "code": "LLM_FABRICATION_BLOCKED",
        "messageKey": "errors.llm.fabricationBlocked",
        "message": "Stopped before inventing experience that isn't in your résumé.",
        "action": {"kind": "fix-input", "fields": []},
    },
    "resume_not_found": {
        "code": "RESOURCE_NOT_FOUND",
        "messageKey": "errors.resource.notFound",
        "message": "We couldn't find that résumé.",
    },
    "source_resume_not_found": {
        "code": "RESOURCE_NOT_FOUND",
        "messageKey": "errors.resource.notFound",
        "message": "We couldn't find the source résumé this suggestion came from.",
    },
    "bullet_not_found": {
        "code": "RESOURCE_NOT_FOUND",
        "messageKey": "errors.resource.notFound",
        "message": "We couldn't find that bullet in the current résumé.",
    },
    "no_valid_suggestions": {
        "code": "VALIDATION_FAILED",
        "messageKey": "errors.validation.failed",
        "message": "None of those suggestions are still valid — they may have already been accepted or rejected.",
    },
    "no_edit": {
        "code": "VALIDATION_FAILED",
        "messageKey": "errors.validation.failed",
        "message": "Couldn't produce a meaningful edit from that instruction — try rephrasing.",
    },
}


def _envelope_from_dict_detail(detail: dict[str, Any], status_code: int) -> dict[str, Any] | None:
    """Map a structured node response (`{"ok": False, "reason": ...}`) to v2
    envelope fields. Returns None when the dict doesn't match a known shape;
    caller falls back to the generic HTTPException path.

    Surfaces fabricated entities via `details.rejectedEntities` exactly as
    docs/architecture/error-handling.md §3 demands so the UI's fix-input CTA
    can list them. Unknown reasons fall through to the status-code default."""
    reason = detail.get("reason")
    if not isinstance(reason, str):
        return None
    mapped = _REASON_TO_ENVELOPE.get(reason)
    if mapped is None:
        return None
    out: dict[str, Any] = dict(mapped)
    # Surface fabricated entities so the UI can render which ones tripped
    # the red line. Trimmed to 20 so we never balloon the response.
    fabricated = detail.get("fabricated")
    if isinstance(fabricated, list) and fabricated:
        details_dict = dict(out.get("details") or {})
        details_dict["rejectedEntities"] = [str(e) for e in fabricated[:20]]
        out["details"] = details_dict
    # Carry the original status — handler chooses the response code from
    # the exception, not this dict, but log/debug needs it.
    out.setdefault("status", status_code)
    return out


def _error_envelope(
    exc: BaseException,
    trace_id: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Build the v2 error envelope around `exc`.

    Stays compatible with the legacy shape (older clients read
    `error.trace_id` / `error.code` lowercase) by emitting *both* the new
    camelCase keys AND the old snake-case `trace_id` side-by-side. The
    web ApiError parser reads either.
    """
    base: dict[str, Any] = {
        "traceId": trace_id,
        "traceCode": _trace_code_from(trace_id),
        "timestamp": _now_iso(),
        # legacy field for clients that haven't migrated yet
        "trace_id": trace_id,
    }
    if request_id:
        base["requestId"] = request_id

    if isinstance(exc, BudgetExhausted):
        return {
            **base,
            "code": "LLM_BUDGET_EXHAUSTED",
            "message": "Your session budget is used up. Try again later or contact support.",
            "messageKey": "errors.llm.budgetExhausted",
            "action": {"kind": "contact", "channel": "in-app"},
        }
    if isinstance(exc, HTTPException):
        # Structured node responses (`{"ok": False, "reason": "..."}` raised as
        # detail) land here. Map them to the v2 catalog so callers see
        # `LLM_FABRICATION_BLOCKED` / `RESOURCE_NOT_FOUND` / ... instead of a
        # bare HTTP-status fallback that loses the rejection signal.
        if isinstance(exc.detail, dict):
            mapped = _envelope_from_dict_detail(exc.detail, exc.status_code)
            if mapped is not None:
                # The status field on `mapped` is informational only — the
                # response status comes from the exception itself.
                mapped.pop("status", None)
                return {**base, **mapped}
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        code = _http_status_code(exc.status_code)
        # Derive a plausible messageKey from the code (UPSTREAM_TIMEOUT →
        # errors.upstream.timeout etc.). Best-effort — web has a fallback
        # for missing keys.
        domain, _, leaf = code.lower().partition("_")
        # Remap a couple of domains to match the i18n namespace.
        if domain in ("internal",):
            domain = "system"
        if domain in ("validation",):
            domain = "validation"
        return {
            **base,
            "code": code,
            "message": detail,
            "messageKey": f"errors.{domain}.{leaf or code.lower()}",
        }
    # Catch-all — never leak str(exc). Support reads the log via traceId.
    return {
        **base,
        "code": "INTERNAL",
        "message": "Something went wrong on our side. We've logged this — please retry shortly.",
        "messageKey": "errors.system.internal",
        "action": {"kind": "retry", "after": 5},
    }


# ── trace middleware ──────────────────────────────────────────────────
# Read X-Trace-Id from the incoming request (gateway sets it; standalone
# clients can send their own) and stash it on request.state so handlers
# and exception handlers find it. Echo it back on every response so the
# browser devtools and the ApiError class get it without parsing JSON.
@app.middleware("http")
async def _trace_middleware(request: Request, call_next):
    inbound = request.headers.get("x-trace-id")
    # Validate inbound shape: 36-char UUID-with-dashes. Anything else gets
    # replaced — clients can't wedge \r\n or 100KB into our log lines.
    if (
        isinstance(inbound, str)
        and len(inbound) == 36
        and all(c in "0123456789abcdefABCDEF-" for c in inbound)
    ):
        trace_id = inbound
    else:
        trace_id = str(uuid4())
    request.state.trace_id = trace_id

    # Pull request id (gateway-stamped per-HTTP) for log correlation.
    request_id = request.headers.get("x-request-id")
    if isinstance(request_id, str) and request_id and len(request_id) <= 200:
        request.state.request_id = request_id

    # structlog binding so every log line inside this request carries the
    # trace id (no need for handlers to thread it).
    structlog.contextvars.bind_contextvars(trace_id=trace_id)

    response = await call_next(request)
    response.headers["X-Trace-Id"] = trace_id
    if request_id:
        response.headers["X-Request-Id"] = request_id
    return response


@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    trace_id = _trace_for(request)
    request_id = _request_id_for(request)
    log.warning(
        "http_exception",
        trace_id=trace_id,
        status=exc.status_code,
        detail=str(exc.detail),
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": _error_envelope(exc, trace_id, request_id)},
        headers={"X-Trace-Id": trace_id},
    )


@app.exception_handler(RequestValidationError)
async def _request_validation_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Map FastAPI's default 422 body shape into the unified v2 envelope.

    Without this handler, Pydantic body/query/header validation failures
    surface as bare ``{"detail": [...]}`` — bypassing the envelope shape
    that error-handling.md §2.1 mandates (code/traceId/traceCode/action).
    Closes the G6 gap for the agents layer (the api gateway side is
    handled by Hono onError).
    """
    trace_id = _trace_for(request)
    request_id = _request_id_for(request)
    # Lift the per-field errors into the unified ``action: fix-input`` shape
    # so the UI can render inline field hints without parsing FastAPI's
    # internal loc/type/msg vocabulary.
    fields: list[dict[str, str]] = []
    for err in exc.errors():
        loc = err.get("loc") or ()
        # Strip the leading "body"/"query"/"header" hop — keep only the
        # caller-visible field path so UI inline hints render cleanly.
        if loc and loc[0] in {"body", "query", "header", "path"}:
            loc = loc[1:]
        name = ".".join(str(p) for p in loc) if loc else "(payload)"
        msg = str(err.get("msg") or "Invalid input")
        fields.append({"name": name, "msg": msg})
    envelope = _error_envelope(
        HTTPException(status_code=422, detail="Validation failed."),
        trace_id,
        request_id,
    )
    envelope["code"] = "VALIDATION_FAILED"
    envelope["messageKey"] = "errors.validation.failed"
    envelope["action"] = {"kind": "fix-input", "fields": fields}
    envelope["details"] = {"fields": fields}
    log.warning(
        "validation_error",
        trace_id=trace_id,
        field_count=len(fields),
    )
    return JSONResponse(
        status_code=422,
        content={"error": envelope},
        headers={"X-Trace-Id": trace_id},
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    trace_id = _trace_for(request)
    request_id = _request_id_for(request)
    # Log the full exception text so support can correlate; the response body
    # only carries the sanitized envelope.
    log.error(
        "unhandled_exception",
        trace_id=trace_id,
        error=redact_exception_text(str(exc)),
        kind=type(exc).__name__,
    )
    status = 402 if isinstance(exc, BudgetExhausted) else 500
    return JSONResponse(
        status_code=status,
        content={"error": _error_envelope(exc, trace_id, request_id)},
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
    message: str = ""
    # HITL resume (AG-UI cutover): instead of a separate /ask/resume endpoint,
    # the client posts a new /ask/stream turn carrying {"resume": <decision>}.
    # Forwarded to LangGraph as Command(resume=...) via dock_agent.run_dock_turn.
    # When set, ``message`` may be empty — the resume decision drives the turn.
    command: dict[str, Any] | None = None


@app.post("/ask/stream")
async def ask_stream(
    payload: AskPayload,
    user_id: UserDep,
    request: Request,
    x_relay_thread_id: Annotated[str | None, Header()] = None,
    x_relay_surface: Annotated[str | None, Header()] = None,
    x_relay_locale: Annotated[str | None, Header()] = None,
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
    # IDOR guard (P0-2): if the gateway forwards an X-Relay-Thread-Id, it
    # MUST belong to the auth'd user. Without this check a hand-crafted
    # header could read another user's lifetime dock thread history. The
    # /ask/resume endpoint has had this check since day one (line 871);
    # /ask/stream had been trusting the header — fixed here. Falling back
    # to ask_vantage_thread_id(user_id) when no header is sent is still
    # safe — that helper derives the thread from the user's own id.
    if x_relay_thread_id and not _owns_dock_thread(thread_id=x_relay_thread_id, user_id=user_id):
        log.warning(
            "ask_stream.thread_id_mismatch",
            thread_id=x_relay_thread_id,
            requested_by=str(user_id),
        )
        raise HTTPException(status_code=403, detail="thread is not yours")
    thread_id = x_relay_thread_id or ask_vantage_thread_id(str(user_id))
    # surface is informational today (we trust the gateway's thread id);
    # logged for observability and reserved for future per-surface context
    # tuning in the router.
    surface = (x_relay_surface or "dock").lower()
    # UI locale forwarded by the gateway (X-Relay-Locale). None → downstream
    # falls back to charset detection so older clients / raw curl still work.
    locale = x_relay_locale
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

    # The middleware stashed the inbound (or freshly minted) trace id on
    # request.state — read it once here and thread it through the
    # generator so every SSE error frame correlates with the same
    # traceId / R-XXXX support reference.
    trace_id = _trace_for(request)
    req_id = _request_id_for(request) or x_request_id

    async def gen() -> AsyncIterator[str]:
        # HITL resume (AG-UI): a turn carrying ``command`` is always a dock
        # resume — feed it straight to the dock graph as Command(resume=...).
        # It emits the full AG-UI lifecycle (RUN_STARTED … RUN_FINISHED) itself,
        # so we don't wrap it in the legacy thinking/done envelope.
        if payload.command is not None:
            async for chunk in _stream_dock_turn(
                message=payload.message,
                user_id=user_id,
                thread_id=thread_id,
                surface=surface,
                locale=locale,
                trace_id=trace_id,
                request_id=req_id,
                command=payload.command,
            ):
                yield chunk
            return

        # Dock ReAct branch (P0-A): when the env flag is set and the cheap
        # regex isn't sure enough to fast-path, delegate the whole turn to
        # the Dock agent. The dock now streams native AG-UI frames (RUN_STARTED
        # … RUN_FINISHED) — no legacy thinking/done wrapper.
        if _DOCK_REACT_ENABLED:
            cheap = cheap_intent_classifier(payload.message)
            if cheap and cheap.confidence >= _DOCK_REGEX_FAST_PATH_THRESHOLD:
                # Fast path: emit an intent frame + dispatch directly, just
                # like the legacy router would. Skips the dock loop entirely.
                # Still on the legacy SSE vocabulary (behind RELAY_DOCK_REACT,
                # default off); the web AG-UI client only sees this once the
                # fast path is migrated in a follow-up.
                yield _sse({"event": "thinking", "agent": "coordinator"})
                yield _sse(
                    {
                        "event": "intent",
                        "intent": cheap.intent,
                        "confidence": cheap.confidence,
                        "via": "regex_fast_path",
                        "args": cheap.args,
                    }
                )
                async for chunk in _dispatch_and_persist(
                    intent=cheap,
                    user_id=user_id,
                    message=payload.message,
                    thread_id=thread_id,
                    surface=surface,
                    locale=locale,
                    trace_id=trace_id,
                    request_id=req_id,
                ):
                    yield chunk
                yield _sse({"event": "done"})
                return

            # Main-loop dock path — emits native AG-UI frames.
            async for chunk in _stream_dock_turn(
                message=payload.message,
                user_id=user_id,
                thread_id=thread_id,
                surface=surface,
                locale=locale,
                trace_id=trace_id,
                request_id=req_id,
            ):
                yield chunk
            return

        # Legacy path (default until RELAY_DOCK_REACT=1): preserves the
        # full router → dispatch behaviour the existing tests cover. New
        # dock-agent tests run against the path above.
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

        async for chunk in _dispatch_and_persist(
            intent=intent,
            user_id=user_id,
            message=payload.message,
            thread_id=thread_id,
            surface=surface,
            locale=locale,
            trace_id=trace_id,
            request_id=req_id,
        ):
            yield chunk

        yield _sse({"event": "done"})

    # Wrap the dock generator in a 10 s heartbeat (event: "ping"). Keeps
    # intermediaries from killing the SSE connection during long ReAct
    # thinking pauses and lets the dock idle-watchdog distinguish
    # "agent is alive but quiet" from "stream is dead".
    return StreamingResponse(_with_heartbeat(gen()), media_type="text/event-stream")


async def _dispatch_and_persist(
    *,
    intent: Any,
    user_id: UUID,
    message: str,
    thread_id: str,
    surface: str,
    locale: str | None = None,
    trace_id: str | None = None,
    request_id: str | None = None,
) -> AsyncIterator[str]:
    """Shared body for legacy + regex-fast-path branches.

    Emits one ``result`` frame (or an ``error`` frame on exception) and
    persists the turn into ``conversation_messages`` for the dock's RECENT
    rail. Factored out so both /ask/stream branches share identical
    error-envelope shaping.
    """
    try:
        result = await dispatch(
            intent,
            user_id=user_id,
            message=message,
            thread_id=thread_id,
            surface=surface,
            locale=locale,
        )
        yield _sse({"event": "result", **result})
        await persist_turn(
            thread_id=thread_id,
            user_id=user_id,
            user_message=message,
            assistant_text=_result_summary(result),
        )
    except Exception as exc:  # noqa: BLE001 boundary
        # Reuse the request-scoped trace id (from the middleware) so this
        # error frame correlates with every other log line for the same
        # turn. Falling back to a fresh UUID only happens when the SSE
        # generator was constructed outside an HTTP request (tests).
        tid = trace_id or str(uuid4())
        log.error(
            "ask_stream.dispatch_failed",
            trace_id=tid,
            error=redact_exception_text(str(exc)),
            kind=type(exc).__name__,
        )
        envelope = _error_envelope(exc, tid, request_id)
        yield _sse({"event": "error", **envelope})


async def _stream_dock_turn(
    *,
    message: str,
    user_id: UUID,
    thread_id: str,
    surface: str,
    locale: str | None = None,
    trace_id: str | None = None,
    request_id: str | None = None,
    command: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """Run the Dock loop and forward its native AG-UI SSE frames verbatim.

    ``dock_agent.run_dock_turn`` now yields already-encoded AG-UI frames
    (``data: {...}\\n\\n``) carrying the standard event vocabulary plus the
    Relay ``relay.*`` CUSTOM events. We pass them straight through — no
    translation. The Bun gateway is likewise a pass-through, so the web
    ``@ag-ui/client`` consumer is the single place that interprets the frames.

    On an uncaught error we emit a ``RUN_ERROR`` AG-UI frame (via the emitter)
    so the client's error path fires with a trace code. ``command`` resumes a
    parked interrupt (Command(resume=...)); when set ``message`` may be empty.

    History persistence (conversation_messages) is done HERE, in the agent
    layer, by sniffing the TEXT_MESSAGE_CONTENT deltas off the forwarded
    frames. The Bun gateway is a pure byte pass-through and no longer parses
    the stream, so this is the only place that can reconstruct the assistant
    turn text for the dock's RECENT rail.
    """
    from agents.coordinator import dock_agent, dock_tools
    from agents.coordinator.user_brief import build_user_brief
    from agents.harness.events import RelayEmitter
    from agents.harness.locale import language_directive

    assistant_buf: list[str] = []

    tokens = dock_tools.set_dock_context(user_id=user_id, thread_id=thread_id, surface=surface)
    # Pin the dock's reply language to the user's UI locale (X-Relay-Locale).
    # Passed as an extra system block so the persistent graph prompt stays
    # cacheable. Falls back to charset detection of the message when locale
    # is absent (older clients).
    lang_block = language_directive(locale, message)
    # P1-2: per-turn user context (active résumé, recent applications, last
    # interview weak points, preferences). Empty string when there's nothing
    # to say or PG is offline — the SystemMessage filter drops it.
    try:
        user_brief_block = await build_user_brief(user_id)
    except Exception as exc:  # noqa: BLE001 — best-effort, never block dock
        log.warning(
            "ask_stream.user_brief_failed",
            error=redact_exception_text(str(exc)),
            kind=type(exc).__name__,
        )
        user_brief_block = ""
    try:
        try:
            async for frame in dock_agent.run_dock_turn(
                message=message,
                thread_id=thread_id,
                trace_id=trace_id,
                extra_system_blocks=[lang_block, user_brief_block],
                command=command,
            ):
                _accumulate_assistant_text(frame, assistant_buf)
                yield frame
        except Exception as exc:  # noqa: BLE001 boundary
            tid = trace_id or str(uuid4())
            # Some exceptions (notably bare ``raise NotImplementedError`` deep
            # in LangGraph / a streaming adapter) carry no message — the
            # one-line redacted str(exc) is then empty and useless. Capture
            # the full chained traceback (redacted) so operators can find the
            # root frame the next time this fires.
            import traceback as _tb

            tb_text = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
            log.error(
                "ask_stream.dock_turn_failed",
                trace_id=tid,
                error=redact_exception_text(str(exc)),
                kind=type(exc).__name__,
                traceback=redact_exception_text(tb_text),
            )
            # Surface as a native AG-UI RUN_ERROR frame so the web client's
            # error path fires. The envelope still carries the trace id for
            # support correlation via the Relay raw_event.
            err_emitter = RelayEmitter(run_id=str(uuid4()), thread_id=thread_id, trace_id=tid)
            envelope = _error_envelope(exc, tid, request_id)
            yield err_emitter.emit_run_error(
                message=str(envelope.get("message") or "dock turn failed"),
                code=str(envelope.get("code") or "INTERNAL"),
            )
        else:
            assistant_text = "".join(assistant_buf).strip()
            if assistant_text:
                await persist_turn(
                    thread_id=thread_id,
                    user_id=user_id,
                    user_message=message,
                    assistant_text=assistant_text,
                )
    finally:
        dock_tools.reset_dock_context(tokens)


def _accumulate_assistant_text(frame: str, buf: list[str]) -> None:
    """Sniff TEXT_MESSAGE_CONTENT deltas off a forwarded AG-UI SSE frame.

    Used only to reconstruct the assistant turn for conversation history; the
    frame itself is forwarded verbatim regardless of what we extract. A frame
    we can't parse (heartbeat, malformed) is silently ignored — persistence is
    best-effort and must never break the stream.
    """
    if "TEXT_MESSAGE_CONTENT" not in frame:
        return
    for line in frame.split("\n"):
        if not line.startswith("data:"):
            continue
        try:
            obj = json.loads(line[5:].strip())
        except (ValueError, TypeError):
            continue
        if obj.get("type") == "TEXT_MESSAGE_CONTENT":
            delta = obj.get("delta")
            if isinstance(delta, str) and delta:
                buf.append(delta)


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


# Heartbeat cadence for ``_with_heartbeat``. 10 s is short enough that the
# web idle watchdog (STREAM_IDLE_TIMEOUT_MS = 120 s in ask-stream.ts) never
# trips on a slow LLM, and long enough that we don't spam the wire when a
# tool is actually running. Picked deliberately to be << any real proxy /
# load-balancer idle timeout (NGINX default 60 s).
_HEARTBEAT_INTERVAL_S = 10.0


async def _with_heartbeat(
    source: AsyncIterator[str],
    *,
    interval_s: float = _HEARTBEAT_INTERVAL_S,
) -> AsyncIterator[str]:
    """Forward an SSE source and inject ``event: "ping"`` during stalls.

    Round-12 dock-double-card audit: a long ReAct reasoning step (Chat
    model thinking with no tool calls yet) used to leave the dock spinner
    silent for the full STREAM_IDLE_TIMEOUT_MS, which (a) let intermediate
    proxies drop the connection without notice and (b) gave the user no
    signal that the agent was still alive. Heartbeats are pure liveness
    pings: the TS gateway's ``toNdjson`` already drops unknown event
    names, so old clients ignore them. Newer clients (round-12+) read
    them to reset their idle watchdog and keep the "running" affordance
    fresh.

    Implementation note: we drive ``source.__anext__`` from a thin queue
    pump that runs in a context-copying task (``contextvars.copy_context``).
    Using a raw ``asyncio.create_task`` here would clone the *outer*
    context — but the source generator (``gen()`` above) installs
    ``ContextVar`` tokens via ``dock_tools.set_dock_context``; cancelling
    or resetting them in a sibling context raises ``ValueError("created
    in a different Context")``. Copying the context up-front keeps the
    Token's owning context stable across reset.
    """
    import contextvars

    loop = asyncio.get_running_loop()
    parent_ctx = contextvars.copy_context()
    queue: asyncio.Queue[tuple[str, str | None]] = asyncio.Queue(maxsize=1)

    async def _pump() -> None:
        try:
            async for chunk in source:
                await queue.put(("chunk", chunk))
        except BaseException as exc:  # propagate raise to the outer loop
            await queue.put(("error", repr(exc)))
            raise
        finally:
            await queue.put(("done", None))

    pump_task = loop.create_task(parent_ctx.run(lambda: _pump()))
    try:
        while True:
            try:
                kind, payload = await asyncio.wait_for(queue.get(), timeout=interval_s)
            except TimeoutError:
                # Heartbeat as a dedicated SSE event line (event: heartbeat,
                # data: {}) per docs/architecture/agent-event-stream.md §4.2.
                # It is NOT an AG-UI envelope — the web @ag-ui/client consumer
                # treats it as pure keepalive and resets its idle watchdog.
                yield "event: heartbeat\ndata: {}\n\n"
                continue
            if kind == "done":
                return
            if kind == "error":
                # The pump task already raised; re-raise its exception here
                # so the outer ``except Exception`` block in gen() / the
                # FastAPI boundary handler logs and emits an error frame.
                await pump_task
                return
            yield payload or ""
    finally:
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                # Pump teardown errors are not user-visible — the boundary
                # handler in gen() already captured anything that matters.
                pass


# ───────────────────────────────────────────────────────────────────────
# Ask Vantage — HITL resume (AG-UI cutover)
# ───────────────────────────────────────────────────────────────────────
#
# There is no longer a dedicated /ask/resume endpoint. When the dock graph
# parks on ``interrupt()`` the AG-UI stream surfaces ``relay.hitl_prep`` +
# RUN_FINISHED(outcome=interrupt). The client collects a decision and posts a
# NEW /ask/stream turn with ``command={"resume": <decision>}``; ask_stream
# feeds it to LangGraph as Command(resume=...) via dock_agent.run_dock_turn.
# ``_owns_dock_thread`` is still the IDOR guard for the /ask/stream thread id.


def _owns_dock_thread(*, thread_id: str, user_id: UUID) -> bool:
    """Check the auth'd user owns this dock thread (IDOR guard for HITL).

    Accepts the four thread shapes harness/checkpointer.py produces:
      ``ask_vantage:{user_id}``
      ``resume_studio:{user_id}:{root_id}``
      ``build_resume:{user_id}:{session_id}``
      ``mock:{session_id}``           — verified at /mock/resume already
    """
    if not isinstance(thread_id, str) or ":" not in thread_id:
        return False
    head, _, tail = thread_id.partition(":")
    if head == "mock":
        # mock threads carry their owner in the LangGraph state; the dock
        # never resumes them via /ask/resume (use /mock/resume instead).
        return False
    if head == "ask_vantage":
        return tail == str(user_id)
    if head in {"resume_studio", "build_resume"}:
        # tail is ``{user_id}:{...}``
        embedded = tail.split(":", 1)[0]
        return embedded == str(user_id)
    return False


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
    # An uploaded base is an ORIGINAL (017 dual-track model) — immutable, the
    # left pane of the studio. We also pin bullet stable IDs now so later
    # optimize / vibe passes can target individual lines.
    new_id, assigned_v = await save_resume_version(
        user_id=user_id,
        content_json=parsed,
        parent_version_id=None,
        tailored_for_job=None,
        is_base=True,
        track="original",
        bullet_index=resume_agent.assign_bullet_ids(parsed),
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
# Résumé optimize / suggestions — dual-track model (017 + design doc §6)
# ───────────────────────────────────────────────────────────────────────


class ResumeOptimizePayload(BaseModel):
    base_resume_id: UUID


@app.post("/resume/optimize")
async def resume_optimize(payload: ResumeOptimizePayload, user_id: UserDep) -> dict[str, Any]:
    """No-JD best-practice pass. Produces a suggestion stack and (when there are
    'safe' ones) an auto-applied optimized sibling. Called by the Bun gateway
    right after a base résumé is parsed+saved (the upload chain) and by the
    'optimize' dock chip."""
    result = await resume_agent.optimize_general(payload.base_resume_id, user_id=user_id)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    return result


class ResumeIntakePayload(BaseModel):
    base_resume_id: UUID


@app.post("/resume/intake")
async def resume_intake(payload: ResumeIntakePayload, user_id: UserDep) -> dict[str, Any]:
    """Resume Intake Agent (design §12): parse-superset validation pass over an
    already-saved original. Runs structure_check + proofread + normalize +
    quality_diag, stacks the findings as suggestions (proposed_by='intake'), and
    NEVER mutates the original. Called by the Bun gateway right after a base
    résumé is parsed+saved (the upload chain's slow segment, §12.4)."""
    result = await resume_agent.intake(payload.base_resume_id, user_id=user_id)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    return result


class ApplySuggestionsPayload(BaseModel):
    suggestion_ids: list[UUID]
    target_track: str = "optimized"


@app.post("/resume/apply-suggestions")
async def resume_apply_suggestions(
    payload: ApplySuggestionsPayload, user_id: UserDep
) -> dict[str, Any]:
    """Materialize a set of accepted suggestions into a new version."""
    result = await resume_agent.apply_suggestions(
        payload.suggestion_ids, user_id=user_id, target_track=payload.target_track
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    return result


class SuggestionDecisionPayload(BaseModel):
    decision: str = Field(pattern="^(accept|reject)$")
    decided_via: str = "dock_inline"


@app.post("/resume/suggestions/{suggestion_id}/decision")
async def resume_suggestion_decision(
    suggestion_id: UUID, payload: SuggestionDecisionPayload, user_id: UserDep
) -> dict[str, Any]:
    """Accept or reject a single suggestion inline (dock or studio panel).

    Accepting one suggestion materializes it into an optimized version
    immediately (so the user sees the change land without a separate 'apply'
    step); rejecting just flips its status.
    """
    from agents.nodes import resume_store

    rec = await resume_store.get_suggestion(suggestion_id, user_id)
    if not rec:
        raise HTTPException(status_code=404, detail="suggestion not found")

    if payload.decision == "reject":
        await resume_store.set_suggestion_status(
            suggestion_id, user_id, "rejected", decided_via=payload.decided_via
        )
        return {"ok": True, "status": "rejected"}

    # accept → apply it into a new optimized version
    result = await resume_agent.apply_suggestions([suggestion_id], user_id=user_id)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    return {"ok": True, "status": "accepted", **result}


class ProposeBulletEditPayload(BaseModel):
    resume_id: UUID
    bullet_stable_id: str = Field(min_length=1, max_length=64)
    instruction: str = Field(min_length=1, max_length=2000)


@app.post("/resume/propose-bullet-edit")
async def resume_propose_bullet_edit(
    payload: ProposeBulletEditPayload, user_id: UserDep
) -> dict[str, Any]:
    """Vibe chat on ONE bullet — returns a single proposed suggestion."""
    result = await resume_agent.propose_bullet_edit(
        payload.resume_id, payload.bullet_stable_id, payload.instruction, user_id=user_id
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
    application_id: UUID | None = None  # idempotency: reuse a draft row


@app.post("/applications/prepare")
async def applications_prepare(
    payload: PrepareApplicationPayload,
    user_id: UserDep,
    x_relay_locale: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Run the full delivery-loop saga and return everything the UI needs.

    Drives TTAR (delivery-loop-plan.md § 1). Stage-level fallbacks live in
    workflows.run_prepare_application — this endpoint just shapes the
    response and surfaces the TTAR-relevant fields.

    Locale: ``X-Relay-Locale`` (forwarded by the gateway from the user's
    UI cookie) is normalized and threaded into the workflow state so
    downstream cover-letter / form-answer generators can pin assistant
    language. The artifact language (résumé, cover letter body) still
    follows the JD's language — see ``agents/harness/locale.py``
    ``artifact_language_directive``.
    """
    from agents.coordinator.workflows import run_prepare_application
    from agents.harness.locale import normalize_locale

    ui_locale = normalize_locale(x_relay_locale)
    return await run_prepare_application(
        user_id=user_id,
        jd_url=payload.jd_url,
        base_resume_id=payload.base_resume_id,
        base_resume_content=payload.base_resume_content,
        base_resume_version=payload.base_resume_version,
        form_fields=payload.form_fields,
        application_id=payload.application_id,
        ui_locale=ui_locale,
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
        log.warning("applications.submitted.db_write_failed", error=redact_exception_text(str(exc)))

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
    """Subset of CloudFillRequest from apps/extension/src/cloud-fill.ts.

    EXT_MF1 / EXT_MF2 (round-18): the round-18 audit found this payload
    was the only LLM-bound POST that still accepted unbounded input —
    MockResumePayload (HITL_R3, round-8), MockStartPayload (MOCK_S1,
    round-15), and most of the other agent endpoints have moved to
    Field(max_length=…) by now. A buggy or hostile extension could POST
    a 1 MB jd_url, a 10 000-element fields array, or a deeply-nested
    context dict, and we'd serialize all of it into the LLM context
    (paying tokens) and into structured log lines (paying memory).
    Pin every leaf with the same pattern the round-15 work set:
      jd_url ≤ 2 000  (typical careers URLs are 200-400 chars; 2 000
                       leaves room for tracking params without
                       inviting megabyte abuse).
      fields ≤ 500    (real ATS forms top out around 50-80 fields;
                       500 is a generous ceiling).
      context dict is capped indirectly by Pydantic's default validation
      cycle plus the gateway's 1 MB body cap (round-7 SEC1).
    """

    context: dict[str, Any]  # ATSContext shape, but we only read jdUrl + source
    jd_url: str = Field(max_length=2000)
    fields: list[dict[str, Any]] = Field(max_length=500)

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
    # MOCK_S1 (round-15): the round-15 audit found that MockResumePayload
    # got Field bounds from HITL_R3 (round-8) but MockStartPayload was
    # left as bare `str` everywhere. Mirror the same posture so a buggy
    # client (or attacker) can't POST a 1 MB role string that blows up
    # downstream `intel_brief:<company>:<role>:<round>` cache keys and
    # the structured-log lines that include those values. Caps:
    #   mode_slug ≤ 64  (longest legit slug today is "scene_recreation"
    #                    = 16 chars; 64 leaves room for future modes
    #                    without inviting 1 MB body abuse).
    #   company / role ≤ 200  (longest honest company names are ~60-80
    #                    chars; 200 is a generous ceiling).
    #   round_type ≤ 64 (mirrors the 009 migration CHECK constraint's
    #                    enum values, all single-word identifiers).
    mode_slug: str = Field(min_length=1, max_length=64)
    company: str | None = Field(default=None, max_length=200)
    role: str | None = Field(default=None, max_length=200)
    round_type: str | None = Field(default=None, max_length=64)


@app.post("/mock/start")
async def mock_start(payload: MockStartPayload, user_id: UserDep) -> dict[str, Any]:
    """Boot a new Mock session. The graph runs until the first interrupt()
    (await_user_input on Q1) and returns that to the client."""
    mode = await interview_agent.load_mode(payload.mode_slug, user_id=user_id)
    if not mode:
        raise HTTPException(status_code=404, detail=f"mode '{payload.mode_slug}' not found")

    session_id = uuid4()

    # Create the interview_sessions row so save_to_card can UPDATE later.
    await _create_session_row(
        user_id=user_id, session_id=session_id, mode_id=mode["id"], company=payload.company
    )

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
async def build_resume_resume(
    payload: BuildResumeResumePayload, user_id: UserDep
) -> dict[str, Any]:
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


async def _create_session_row(
    user_id: UUID, session_id: UUID, mode_id: UUID, company: str | None
) -> None:
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
