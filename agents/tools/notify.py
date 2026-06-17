"""NOTIFY-level tools — execute then push WebSocket event.

The API layer reads __relay_permission__ == "NOTIFY" and pushes after the
tool returns. Tools here do the work; notification is the wrapper's job.
"""
from __future__ import annotations

import json
import os
from typing import Any
from uuid import UUID

import psycopg

from agents.harness.permissions import mark_notify


@mark_notify
async def write_user_memory(user_id: UUID, key: str, value: dict[str, Any]) -> bool:
    """Persist a free-form memory entry on user_memories (008 schema)."""
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return False
    sql = """
        INSERT INTO user_memories (user_id, content, metadata)
        VALUES (%s, %s, %s)
    """
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                sql,
                (str(user_id), key + ": " + json.dumps(value)[:1000], json.dumps({key: value})),
            )
        await conn.commit()
    return True


@mark_notify
async def save_resume_version(
    user_id: UUID,
    version: int,
    content_json: dict[str, Any],
    parent_version_id: UUID | None,
    tailored_for_job: UUID | None,
    is_base: bool = False,
) -> UUID:
    """INSERT into resumes table; returns new row id. Optimistic locking handled
    by UNIQUE(user_id, version) — caller must compute next version."""
    import uuid as _uuid

    dsn = os.environ["RELAY_PG_DSN"]  # required for writes
    new_id = _uuid.uuid4()
    sql = """
        INSERT INTO resumes (
            id, user_id, version, content, is_base, tailored_for_job, parent_version
        ) VALUES (%s, %s, %s, %s, %s, %s, %s)
    """
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                sql,
                (
                    str(new_id),
                    str(user_id),
                    version,
                    json.dumps(content_json),
                    is_base,
                    str(tailored_for_job) if tailored_for_job else None,
                    str(parent_version_id) if parent_version_id else None,
                ),
            )
        await conn.commit()
    return new_id
