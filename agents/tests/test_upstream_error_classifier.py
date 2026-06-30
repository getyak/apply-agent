"""Regression tests for `agents.api.errors.classify_upstream_exception`.

The classifier is the agents-layer half of the error-envelope contract
in docs/architecture/error-handling.md §3.1 — every known upstream
failure mode (LLM provider 4xx/5xx, httpx network errors, LangGraph
recursion, asyncio timeouts) must map to a stable ErrorCode + status so
the web error-router renders a real CTA instead of a generic toast.

Caller: pytest auto-discovers this file under agents/tests/.
"""

from __future__ import annotations

import asyncio

import httpx
import openai
import pytest
from langgraph.errors import GraphRecursionError

from agents.api.errors import classify_upstream_exception


def _make_response(status: int, headers: dict[str, str] | None = None) -> httpx.Response:
    request = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    return httpx.Response(status_code=status, headers=headers or {}, request=request)


def test_permission_denied_maps_to_llm_unavailable():
    exc = openai.PermissionDeniedError(
        "Host not in allowlist",
        response=_make_response(403),
        body=None,
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "LLM_UNAVAILABLE"
    assert out["status"] == 503
    assert out["action"]["kind"] == "retry"
    assert out["messageKey"] == "errors.llm.unavailable"


def test_authentication_error_maps_to_llm_unavailable():
    exc = openai.AuthenticationError(
        "Invalid API key",
        response=_make_response(401),
        body=None,
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "LLM_UNAVAILABLE"
    assert out["status"] == 503


def test_rate_limit_error_maps_with_retry_after():
    exc = openai.RateLimitError(
        "Slow down",
        response=_make_response(429, headers={"retry-after": "12"}),
        body=None,
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "RATE_LIMITED"
    assert out["status"] == 429
    assert out["action"]["kind"] == "retry"
    assert out["action"]["after"] == 12
    assert out["details"] == {"retryAfterSeconds": 12}


def test_api_timeout_maps_to_upstream_timeout():
    exc = openai.APITimeoutError(httpx.Request("POST", "https://openrouter.ai/x"))
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "UPSTREAM_TIMEOUT"
    assert out["status"] == 504


def test_api_connection_error_maps_to_upstream_unavailable():
    exc = openai.APIConnectionError(request=httpx.Request("POST", "https://openrouter.ai/x"))
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "UPSTREAM_UNAVAILABLE"
    assert out["status"] == 503


def test_httpx_timeout_maps_to_upstream_timeout():
    out = classify_upstream_exception(httpx.ReadTimeout("slow"))
    assert out is not None
    assert out["code"] == "UPSTREAM_TIMEOUT"
    assert out["status"] == 504


def test_httpx_status_5xx_maps_to_upstream_unavailable():
    exc = httpx.HTTPStatusError(
        "server error",
        request=httpx.Request("GET", "https://x"),
        response=_make_response(503),
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "UPSTREAM_UNAVAILABLE"


def test_httpx_status_429_maps_to_rate_limited():
    exc = httpx.HTTPStatusError(
        "throttled",
        request=httpx.Request("GET", "https://x"),
        response=_make_response(429),
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "RATE_LIMITED"
    assert out["status"] == 429


def test_graph_recursion_maps_to_agent_timeout():
    out = classify_upstream_exception(GraphRecursionError("limit"))
    assert out is not None
    assert out["code"] == "AGENT_TIMEOUT"
    assert out["status"] == 504


def test_asyncio_timeout_maps_to_upstream_timeout():
    # asyncio.TimeoutError aliases TimeoutError on 3.11+; both must classify.
    out = classify_upstream_exception(TimeoutError())
    assert out is not None
    assert out["code"] == "UPSTREAM_TIMEOUT"
    assert asyncio.TimeoutError is TimeoutError


def test_unknown_exception_returns_none():
    out = classify_upstream_exception(RuntimeError("something else"))
    assert out is None


def test_message_does_not_leak_provider_text():
    """Whatever the provider yelled at us, our message stays user-safe."""
    exc = openai.PermissionDeniedError(
        "internal trace-id=abc123 quota exhausted for key sk-xyz",
        response=_make_response(403),
        body=None,
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    assert "sk-xyz" not in out["message"]
    assert "abc123" not in out["message"]


def test_retry_after_invalid_header_is_ignored():
    exc = openai.RateLimitError(
        "Slow down",
        response=_make_response(429, headers={"retry-after": "not-a-number"}),
        body=None,
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    # falls back to default of 10
    assert out["action"]["after"] == 10
    assert out.get("details") is None


@pytest.mark.parametrize("status", [400, 409, 422])
def test_apistatuserror_other_4xx_maps_to_llm_unavailable(status: int):
    exc = openai.APIStatusError(
        "weird",
        response=_make_response(status),
        body=None,
    )
    out = classify_upstream_exception(exc)
    assert out is not None
    assert out["code"] == "LLM_UNAVAILABLE"
