"""AUTO-level tools — execute silently, no notification, no approval.

Used by all agents for low-risk read operations.
"""
from __future__ import annotations

import hashlib
import os
from typing import Any

import httpx

from agents.harness.permissions import mark_auto


@mark_auto
async def fetch_url(url: str, timeout_s: int = 15) -> str:
    """GET a URL and return the text body. Bounded by timeout + size."""
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
