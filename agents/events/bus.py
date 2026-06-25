"""Redis Streams event bus — cross-graph fan-out.

Caller:
  - nodes/resume_agent.py publishes 'resume:updated' after writing v_n+1
  - nodes/interview_agent.py publishes 'mock:weak_point_found' after save_to_card
  - Future workers subscribe to recompute job matches / dispatch notifications.

Key shape: relay:events:{topic} as a Redis Stream.
Payload shape: {"user_id": "...", "occurred_at": "<iso8601>", **topic-specific}
"""
from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any
from uuid import UUID


def _redis_url() -> str:
    return os.environ.get("RELAY_REDIS_URL", "redis://localhost:6380/0")


async def publish(topic: str, payload: dict[str, Any]) -> str | None:
    """XADD into relay:events:{topic}. Returns the new entry id."""
    try:
        import redis.asyncio as redis
    except ImportError:
        return None
    client = redis.from_url(_redis_url(), decode_responses=True)
    try:
        enriched = {
            "occurred_at": datetime.now(UTC).isoformat(),
            "data": json.dumps(payload, default=_serialize),
        }
        return await client.xadd(f"relay:events:{topic}", enriched, maxlen=10_000, approximate=True)
    finally:
        await client.aclose()


async def subscribe(topic: str, last_id: str = "$"):
    """Async generator yielding new entries from a topic.

    Usage:
        async for entry in subscribe('resume:updated'):
            ...
    """
    try:
        import redis.asyncio as redis
        from redis.exceptions import TimeoutError as RedisTimeoutError
    except ImportError:
        return
    # socket_timeout must exceed the XREAD BLOCK window, otherwise the client-side
    # read times out before the server returns and the pump dies. Give it headroom.
    block_ms = 5000
    client = redis.from_url(
        _redis_url(),
        decode_responses=True,
        socket_timeout=block_ms / 1000 + 5,
    )
    cursor = last_id
    try:
        while True:
            try:
                entries = await client.xread(
                    {f"relay:events:{topic}": cursor}, block=block_ms, count=10
                )
            except RedisTimeoutError:
                # No new events within the block window — idle, not an error.
                # Keep polling instead of letting the exception kill the pump.
                continue
            for _stream, items in entries:
                for entry_id, fields in items:
                    cursor = entry_id
                    yield {"id": entry_id, **fields, "data": json.loads(fields.get("data", "{}"))}
    finally:
        await client.aclose()


def _serialize(obj: Any) -> Any:
    if isinstance(obj, UUID):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Cannot JSON-serialize {type(obj).__name__}")
