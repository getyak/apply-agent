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
from datetime import datetime, timezone
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
            "occurred_at": datetime.now(timezone.utc).isoformat(),
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
    except ImportError:
        return
    client = redis.from_url(_redis_url(), decode_responses=True)
    cursor = last_id
    try:
        while True:
            entries = await client.xread({f"relay:events:{topic}": cursor}, block=5000, count=10)
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
