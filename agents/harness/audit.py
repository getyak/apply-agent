"""Audit logger — inserts agent_tasks rows after each agent invocation.

Caller: every node entry point wraps its body in `with audit(...)`; on exit
the row is INSERTed with status/cost/latency. HITL fields populated by tool
wrapper in agents/harness/permissions.py.

Schema reference: infra/postgres/migrations/010_agents.sql — agent_tasks.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

import structlog


log = structlog.get_logger("agents.audit")


@dataclass
class AuditRecord:
    user_id: UUID
    agent_type: str
    action: str
    session_id: UUID | None = None
    input_params: dict[str, Any] = field(default_factory=dict)
    output_result: dict[str, Any] | None = None
    status: str = "running"
    error_message: str | None = None
    total_tokens: int = 0
    total_cost_cents: float = 0.0
    latency_ms: int = 0
    model_used: str | None = None
    cache_hit: bool = False
    started_at: float = field(default_factory=time.time)


async def _insert(record: AuditRecord) -> None:
    """Insert AuditRecord into agent_tasks. Best-effort: never blocks the agent."""
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        log.warning("audit.skipped_no_dsn", **record.__dict__)
        return

    try:
        import psycopg  # local import to keep test runs fast
    except ImportError:
        log.error("audit.psycopg_missing")
        return

    sql = """
        INSERT INTO agent_tasks (
            id, user_id, session_id, agent_type, action,
            input_params, output_result, status, error_message,
            total_tokens, total_cost_cents, latency_ms, model_used, cache_hit,
            completed_at
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
    """
    params = (
        str(uuid4()),
        str(record.user_id),
        str(record.session_id) if record.session_id else None,
        record.agent_type,
        record.action,
        psycopg_dumps(record.input_params),
        psycopg_dumps(record.output_result) if record.output_result else None,
        record.status,
        record.error_message,
        record.total_tokens,
        record.total_cost_cents,
        record.latency_ms,
        record.model_used,
        record.cache_hit,
    )
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
            await conn.commit()
    except Exception as exc:  # noqa: BLE001 boundary
        log.error("audit.insert_failed", error=str(exc))


def psycopg_dumps(obj: Any) -> str:
    """JSON-stringify for JSONB columns."""
    import json
    return json.dumps(obj, default=str)


@asynccontextmanager
async def audit(
    user_id: UUID,
    agent_type: str,
    action: str,
    session_id: UUID | None = None,
    input_params: dict[str, Any] | None = None,
):
    """Async context manager: records start, captures exceptions, logs end."""
    record = AuditRecord(
        user_id=user_id,
        agent_type=agent_type,
        action=action,
        session_id=session_id,
        input_params=input_params or {},
    )
    start = time.perf_counter()
    try:
        yield record
        record.status = "completed"
    except Exception as exc:
        record.status = "failed"
        record.error_message = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        record.latency_ms = int((time.perf_counter() - start) * 1000)
        # Fire-and-forget (boundary insert, must never block agent return).
        with contextlib.suppress(RuntimeError):
            asyncio.create_task(_insert(record))
