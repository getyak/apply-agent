"""AUTO-level tools — execute silently, no notification, no approval.

Used by all agents for low-risk read operations.
"""
from __future__ import annotations

import hashlib
import ipaddress
import os
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

from agents.harness.permissions import mark_auto

# TOOLS3 (round-9): every AUTO-level fetch must pre-flight the URL through
# this guard. The round-9 tools-audit flagged that `fetch_url`, despite
# being one of the most agent-callable surfaces, accepted any URL — so a
# prompt-injected resume or JD could nudge an agent into calling
# `fetch_url("http://169.254.169.254/")` or `fetch_url("file:///etc/passwd")`.
# The round-7 jobmatch audit closed the same hole there with the same
# helper shape; this is the deliberate copy until round-10 lifts the
# logic into a shared `agents/harness/security.py` module (today the
# duplication is small and the risk of a circular import on a new
# harness module mid-round is higher than the cost of the duplication).
_AUTO_ALLOWED_SCHEMES = {"http", "https"}


def _is_public_http_url(url: str) -> tuple[bool, str]:
    """Return (ok, reason) — reject SSRF-adjacent URLs.

    Mirrors the helper in agents/nodes/jobmatch_agent.py. Both must agree
    on the policy so a prompt that swaps fetcher tools can't side-step it.
    """
    try:
        parsed = urlparse(url)
    except ValueError as exc:
        return False, f"urlparse failed: {exc}"
    if parsed.scheme.lower() not in _AUTO_ALLOWED_SCHEMES:
        return False, f"scheme {parsed.scheme!r} is not http/https"
    host = parsed.hostname
    if not host:
        return False, "URL has no hostname"
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as exc:
        return False, f"DNS failure for {host!r}: {exc}"
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split("%")[0])
        except ValueError:
            continue
        if not ip.is_global:
            return False, f"{host} resolves to non-public {ip}"
    return True, ""


@mark_auto
async def fetch_url(url: str, timeout_s: int = 15) -> str:
    """GET a URL and return the text body. Bounded by timeout + size.

    Raises ValueError when the URL would target a non-public address
    (SSRF guard); see _is_public_http_url for the policy.
    """
    ok, reason = _is_public_http_url(url)
    if not ok:
        raise ValueError(f"refusing to fetch {url}: {reason}")
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        r = await client.get(url, follow_redirects=True)
        r.raise_for_status()
        return r.text[:500_000]  # 500KB cap


@mark_auto
def hash_content(content: str) -> str:
    """SHA256 hash for cache key derivation."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


@mark_auto
async def redis_get(key: str) -> str | None:
    """Read a string value from Redis (6380). Returns None on miss."""
    try:
        import redis.asyncio as redis  # local import
    except ImportError:
        return None
    url = os.environ.get("RELAY_REDIS_URL", "redis://localhost:6380/0")
    client = redis.from_url(url, decode_responses=True)
    try:
        return await client.get(key)
    finally:
        await client.aclose()


@mark_auto
async def redis_setex(key: str, ttl_seconds: int, value: str) -> bool:
    """SETEX into Redis. Returns True on success."""
    try:
        import redis.asyncio as redis
    except ImportError:
        return False
    url = os.environ.get("RELAY_REDIS_URL", "redis://localhost:6380/0")
    client = redis.from_url(url, decode_responses=True)
    try:
        await client.setex(key, ttl_seconds, value)
        return True
    finally:
        await client.aclose()


@mark_auto
async def pg_query(sql: str, params: tuple[Any, ...] = ()) -> list[dict]:
    """Read-only PG query helper. SECURITY: only parameterised SQL allowed —
    no string concat (RULES.md non-negotiable)."""
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return []
    import psycopg
    from psycopg.rows import dict_row

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()
