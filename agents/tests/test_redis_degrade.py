"""Round-20 regression: redis_get / redis_setex must degrade silently when
Redis is unreachable (ConnectionRefusedError / TimeoutError / auth) instead
of crashing the calling node.

Cache is an optimisation — not a correctness requirement
(docs/architecture/error-handling.md: CACHE_UNAVAILABLE → graceful retry).
A bug that let ConnectionError bubble was the root cause of every
`prepare_application` customize stage failing on a dev box without Redis.
"""

from __future__ import annotations

import pytest

from agents.tools.auto import redis_get, redis_setex


async def test_redis_get_returns_none_on_connection_refused(monkeypatch):
    """Point at a closed loopback port — must yield None, not raise."""
    monkeypatch.setenv("RELAY_REDIS_URL", "redis://127.0.0.1:1/0")
    result = await redis_get("any-key")
    assert result is None


async def test_redis_setex_returns_false_on_connection_refused(monkeypatch):
    """Same closed port — must yield False, not raise."""
    monkeypatch.setenv("RELAY_REDIS_URL", "redis://127.0.0.1:1/0")
    result = await redis_setex("k", 60, "v")
    assert result is False


async def test_redis_get_returns_none_on_unparseable_url(monkeypatch):
    """Bad URL construction (e.g. mis-quoted env var) → None, no traceback."""
    monkeypatch.setenv("RELAY_REDIS_URL", "not-a-url://garbage")
    result = await redis_get("k")
    assert result is None


async def test_redis_setex_returns_false_on_unparseable_url(monkeypatch):
    monkeypatch.setenv("RELAY_REDIS_URL", "not-a-url://garbage")
    result = await redis_setex("k", 60, "v")
    assert result is False


@pytest.mark.parametrize("url_segment", ["timeout://", "redis://[::1]:1/0"])
async def test_redis_get_handles_assorted_connection_errors(monkeypatch, url_segment):
    monkeypatch.setenv("RELAY_REDIS_URL", url_segment)
    result = await redis_get("k")
    assert result is None
