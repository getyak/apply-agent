"""Upstream exception → ErrorCode mapping for the agents API.

Implements docs/architecture/error-handling.md §3.1 for the Python layer.
The Bun gateway already does the same translation for PG/Redis/network in
api/src/errors.ts (`translateInfraError`); this module is its agents-side
analogue for the LLM provider (OpenRouter / langchain_openai / httpx) and
LangGraph runtime errors.

Why this exists: the unified `_unhandled_exception_handler` in server.py
otherwise routes every uncaught exception to `INTERNAL` 500, which violates
the error-handling canon's P1 ("every user-facing error is a product, not
an exception") — an LLM 403 / timeout / connection error must surface as
`LLM_UNAVAILABLE` 503 / `UPSTREAM_TIMEOUT` 504 with a retry action so the
web error-router can render a real CTA.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import openai
from langgraph.errors import GraphRecursionError


def classify_upstream_exception(exc: BaseException) -> dict[str, Any] | None:
    """Return a partial error envelope for known upstream failure modes.

    Shape: `{"status": int, "code": str, "message": str, "messageKey": str,
            "action": dict, "details": dict|None}` — merged into the v2 base
    envelope by `_error_envelope`. Returns `None` when the exception isn't a
    known upstream class so the catch-all (`INTERNAL`) still applies.

    Keep `message` user-safe (no raw provider text, no stack trace) — support
    correlates via traceId, not the body.
    """

    # OpenAI / langchain_openai (OpenRouter sits behind this client).
    # Order matters: subclasses first.
    if isinstance(exc, openai.APITimeoutError):
        return {
            "status": 504,
            "code": "UPSTREAM_TIMEOUT",
            "message": "The reasoning engine took too long to respond.",
            "messageKey": "errors.upstream.timeout",
            "action": {"kind": "retry", "after": 5},
        }
    if isinstance(exc, openai.RateLimitError):
        retry_after = _extract_retry_after(exc)
        return {
            "status": 429,
            "code": "RATE_LIMITED",
            "message": "You're sending requests too quickly. Try again shortly.",
            "messageKey": "errors.rate.limited",
            "action": {"kind": "retry", "after": retry_after or 10},
            "details": {"retryAfterSeconds": retry_after} if retry_after else None,
        }
    if isinstance(exc, (openai.PermissionDeniedError, openai.AuthenticationError)):
        # 403 / 401 from the upstream — host blocked, key revoked, region
        # gated. Surface as LLM_UNAVAILABLE (operator's problem to fix);
        # never leak the underlying provider message which may contain
        # quota / billing detail.
        return {
            "status": 503,
            "code": "LLM_UNAVAILABLE",
            "message": "The reasoning engine is temporarily unavailable.",
            "messageKey": "errors.llm.unavailable",
            "action": {"kind": "retry", "after": 10},
        }
    if isinstance(exc, openai.APIConnectionError):
        return {
            "status": 503,
            "code": "UPSTREAM_UNAVAILABLE",
            "message": "Couldn't reach the reasoning engine.",
            "messageKey": "errors.upstream.unavailable",
            "action": {"kind": "retry", "after": 5},
        }
    if isinstance(exc, openai.APIStatusError):
        # Catch-all for other provider-side 4xx/5xx (BadRequestError,
        # ConflictError, InternalServerError…). The provider rejected the
        # request shape or returned a 5xx we don't have a dedicated mapping
        # for — surface as LLM_UNAVAILABLE rather than INTERNAL.
        return {
            "status": 503,
            "code": "LLM_UNAVAILABLE",
            "message": "The reasoning engine returned an unexpected response.",
            "messageKey": "errors.llm.unavailable",
            "action": {"kind": "retry", "after": 10},
        }
    if isinstance(exc, openai.APIError):
        return {
            "status": 503,
            "code": "LLM_UNAVAILABLE",
            "message": "The reasoning engine is temporarily unavailable.",
            "messageKey": "errors.llm.unavailable",
            "action": {"kind": "retry", "after": 10},
        }

    # httpx — when callers bypass the openai client (e.g. browser MCP).
    if isinstance(exc, httpx.TimeoutException):
        return {
            "status": 504,
            "code": "UPSTREAM_TIMEOUT",
            "message": "An upstream service took too long to respond.",
            "messageKey": "errors.upstream.timeout",
            "action": {"kind": "retry", "after": 5},
        }
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if 500 <= status < 600:
            return {
                "status": 503,
                "code": "UPSTREAM_UNAVAILABLE",
                "message": "An upstream service returned an error.",
                "messageKey": "errors.upstream.unavailable",
                "action": {"kind": "retry", "after": 5},
            }
        if status in (401, 403):
            return {
                "status": 503,
                "code": "UPSTREAM_UNAVAILABLE",
                "message": "An upstream service rejected the request.",
                "messageKey": "errors.upstream.unavailable",
                "action": {"kind": "retry", "after": 10},
            }
        if status == 429:
            return {
                "status": 429,
                "code": "RATE_LIMITED",
                "message": "Upstream rate limit hit.",
                "messageKey": "errors.rate.limited",
                "action": {"kind": "retry", "after": 10},
            }
    if isinstance(exc, httpx.ConnectError):
        return {
            "status": 503,
            "code": "UPSTREAM_UNAVAILABLE",
            "message": "Couldn't reach an upstream service.",
            "messageKey": "errors.upstream.unavailable",
            "action": {"kind": "retry", "after": 5},
        }

    # LangGraph recursion (agent loop hit recursion_limit) — distinct from
    # an HTTP timeout but maps to the same surface: AGENT_TIMEOUT 504.
    if isinstance(exc, GraphRecursionError):
        return {
            "status": 504,
            "code": "AGENT_TIMEOUT",
            "message": "The agent loop didn't reach a stopping state in time.",
            "messageKey": "errors.agent.timeout",
            "action": {"kind": "retry", "after": 5},
        }

    # Plain asyncio timeout — usually from `asyncio.wait_for` around an
    # invoke. Treat it as UPSTREAM_TIMEOUT (it almost always wraps a slow
    # provider call) so the web error-router shows the same CTA.
    if isinstance(exc, asyncio.TimeoutError):
        return {
            "status": 504,
            "code": "UPSTREAM_TIMEOUT",
            "message": "An upstream operation timed out.",
            "messageKey": "errors.upstream.timeout",
            "action": {"kind": "retry", "after": 5},
        }

    return None


def _extract_retry_after(exc: BaseException) -> int | None:
    """Pull the Retry-After header from a RateLimitError if present."""
    response = getattr(exc, "response", None)
    if response is None:
        return None
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    raw = headers.get("retry-after") or headers.get("Retry-After")
    if not raw:
        return None
    try:
        return max(1, int(float(raw)))
    except (TypeError, ValueError):
        return None
