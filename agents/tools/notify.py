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
    content_json: dict[str, Any],
    parent_version_id: UUID | None,
    tailored_for_job: UUID | None,
    is_base: bool = False,
    version: int = 0,
    track: str | None = None,
    bullet_index: dict[str, Any] | None = None,
) -> tuple[UUID, int]:
    """INSERT into resumes; returns (new_row_id, assigned_version).

    Migration 016 installs a BEFORE INSERT trigger that assigns the next
    per-user version under an advisory lock when ``version`` is 0 or NULL.
    Callers should leave ``version`` at its default; it stays a parameter
    for the rare case where a specific version must be forced (e.g. a
    backfill script). The trigger keeps the UNIQUE(user_id, version)
    constraint safe under concurrent writers — no more 23505 races.

    Migration 017 (dual-track model) adds ``track`` and ``bullet_index``:
    - ``track`` ∈ {original, optimized, tailored}. When None it's derived:
      tailored if a job id is present, else optimized. ``original`` is only
      written by the upload path (api/src/routes/resumes.ts), never here —
      originals are immutable, so this Python writer never produces one.
    - ``bullet_index`` pins stable IDs to each highlight (see
      resume_agent.assign_bullet_ids). It carries forward across optimized /
      tailored versions so vibe edits can target the same bullet over time.
    ``derived_from`` is written from ``parent_version_id`` (the 017 column is
    the clearer name for the same relationship; we set both for compatibility).
    """
    import uuid as _uuid

    if track is None:
        track = "tailored" if tailored_for_job else "optimized"

    dsn = os.environ["RELAY_PG_DSN"]  # required for writes
    new_id = _uuid.uuid4()
    sql = """
        INSERT INTO resumes (
            id, user_id, version, content, is_base, tailored_for_job,
            parent_version, derived_from, track, bullet_index
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING version
    """
    parent = str(parent_version_id) if parent_version_id else None
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
                    parent,
                    parent,  # derived_from mirrors parent_version
                    track,
                    json.dumps(bullet_index) if bullet_index is not None else None,
                ),
            )
            row = await cur.fetchone()
        await conn.commit()
    assigned_version = int(row[0]) if row else version
    return new_id, assigned_version
