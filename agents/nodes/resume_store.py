"""Data-access layer for the dual-track résumé model (migration 017).

Kept separate from resume_agent.py (which holds the LLM business logic) so
neither file grows past the project's 800-line ceiling. Pure DB I/O — no LLM
calls, no fabrication logic. All functions are owner-scoped: a user_id mismatch
yields nothing, never another user's data.

Backs docs/design/resume-original-vs-optimized-vibe-design.md §4.
"""

from __future__ import annotations

import json
import os
from typing import Any
from uuid import UUID, uuid4

import psycopg
import structlog

log = structlog.get_logger("agents.nodes.resume_store")


def _dsn() -> str:
    return os.environ["RELAY_PG_DSN"]


# ───────────────────────────────────────────────────────────────────────
# résumé reads
# ───────────────────────────────────────────────────────────────────────


async def get_resume(resume_id: UUID, user_id: UUID) -> dict[str, Any] | None:
    """Return {id, content, track, bullet_index, version} or None.

    Owner-scoped. `content` is the stored JSONB; callers usually want the
    `parsed` JSON Resume nested inside it (see unwrap_parsed).
    """
    sql = """
        SELECT id, content, track, bullet_index, version
          FROM resumes
         WHERE id = %s AND user_id = %s
    """
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, (str(resume_id), str(user_id)))
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": str(row[0]),
        "content": row[1],
        "track": row[2],
        "bullet_index": row[3],
        "version": int(row[4]),
    }


async def get_current_original(user_id: UUID) -> dict[str, Any] | None:
    """The user's current base original (is_base = true, track = 'original')."""
    sql = """
        SELECT id, content, track, bullet_index, version
          FROM resumes
         WHERE user_id = %s AND is_base = true
         ORDER BY created_at DESC
         LIMIT 1
    """
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, (str(user_id),))
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": str(row[0]),
        "content": row[1],
        "track": row[2],
        "bullet_index": row[3],
        "version": int(row[4]),
    }


def unwrap_parsed(content: Any) -> dict[str, Any]:
    """Pull the JSON Resume document out of the stored content envelope.

    The upload path stores `{raw, parsed, warnings, ...}`; older / agent-written
    rows may store the JSON Resume document directly. Be forgiving of both.
    """
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            return {}
    if not isinstance(content, dict):
        return {}
    if isinstance(content.get("parsed"), dict):
        return content["parsed"]
    return content


# ───────────────────────────────────────────────────────────────────────
# bullet_index persistence (back-fill an original that predates 017)
# ───────────────────────────────────────────────────────────────────────


async def set_bullet_index(resume_id: UUID, user_id: UUID, bullet_index: dict[str, Any]) -> bool:
    """Attach a bullet_index to a row. Safe on originals — bullet_index is
    metadata, not content, so the immutability trigger allows it."""
    sql = """
        UPDATE resumes SET bullet_index = %s
         WHERE id = %s AND user_id = %s
    """
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, (json.dumps(bullet_index), str(resume_id), str(user_id)))
            updated = cur.rowcount
        await conn.commit()
    return updated > 0


# ───────────────────────────────────────────────────────────────────────
# resume_suggestions CRUD
# ───────────────────────────────────────────────────────────────────────


async def insert_suggestions(
    user_id: UUID,
    source_resume_id: UUID,
    suggestions: list[dict[str, Any]],
    proposed_by: str,
) -> list[dict[str, Any]]:
    """Bulk-insert proposed suggestions; returns them with their new ids.

    Each suggestion dict must carry: change_type, before_text, after_text,
    risk_level. Optional: bullet_stable_id, section, rationale,
    fabrication_check.
    """
    if not suggestions:
        return []
    sql = """
        INSERT INTO resume_suggestions (
            id, user_id, source_resume_id, bullet_stable_id, section,
            change_type, before_text, after_text, rationale, risk_level,
            fabrication_check, status, proposed_by
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'proposed', %s)
    """
    out: list[dict[str, Any]] = []
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            for s in suggestions:
                sid = uuid4()
                await cur.execute(
                    sql,
                    (
                        str(sid),
                        str(user_id),
                        str(source_resume_id),
                        s.get("bullet_stable_id"),
                        s.get("section"),
                        s["change_type"],
                        s["before_text"],
                        s["after_text"],
                        s.get("rationale"),
                        s.get("risk_level", "needs_review"),
                        json.dumps(s["fabrication_check"]) if s.get("fabrication_check") else None,
                        proposed_by,
                    ),
                )
                out.append({**s, "id": str(sid), "status": "proposed"})
        await conn.commit()
    return out


async def get_suggestion(suggestion_id: UUID, user_id: UUID) -> dict[str, Any] | None:
    sql = """
        SELECT id, source_resume_id, bullet_stable_id, section, change_type,
               before_text, after_text, rationale, risk_level, status, proposed_by
          FROM resume_suggestions
         WHERE id = %s AND user_id = %s
    """
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, (str(suggestion_id), str(user_id)))
            row = await cur.fetchone()
    if not row:
        return None
    cols = (
        "id",
        "source_resume_id",
        "bullet_stable_id",
        "section",
        "change_type",
        "before_text",
        "after_text",
        "rationale",
        "risk_level",
        "status",
        "proposed_by",
    )
    rec = dict(zip(cols, row, strict=False))
    rec["id"] = str(rec["id"])
    rec["source_resume_id"] = str(rec["source_resume_id"])
    return rec


async def list_suggestions(
    user_id: UUID, source_resume_id: UUID, status: str | None = None
) -> list[dict[str, Any]]:
    sql = """
        SELECT id, bullet_stable_id, section, change_type, before_text,
               after_text, rationale, risk_level, status, proposed_by
          FROM resume_suggestions
         WHERE user_id = %s AND source_resume_id = %s
    """
    params: list[Any] = [str(user_id), str(source_resume_id)]
    if status:
        sql += " AND status = %s"
        params.append(status)
    sql += " ORDER BY proposed_at ASC"
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, tuple(params))
            rows = await cur.fetchall()
    cols = (
        "id",
        "bullet_stable_id",
        "section",
        "change_type",
        "before_text",
        "after_text",
        "rationale",
        "risk_level",
        "status",
        "proposed_by",
    )
    out = []
    for row in rows:
        rec = dict(zip(cols, row, strict=False))
        rec["id"] = str(rec["id"])
        out.append(rec)
    return out


async def set_suggestion_status(
    suggestion_id: UUID, user_id: UUID, status: str, decided_via: str | None = None
) -> bool:
    """Mark a suggestion accepted / rejected / superseded. Owner-scoped."""
    sql = """
        UPDATE resume_suggestions
           SET status = %s, decided_at = now(), decided_via = %s
         WHERE id = %s AND user_id = %s
    """
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, (status, decided_via, str(suggestion_id), str(user_id)))
            updated = cur.rowcount
        await conn.commit()
    return updated > 0
