"""Application kanban tools — agent-side counterpart to the TS PATCH route.

Used by the coordinator router's ``applications`` intent (see
vantage-ui-mapping.md §2.6 / Applications surface). The TS API layer at
``api/src/routes/applications.ts`` already implements the same writes for
the web UI; these tools let an agent perform them from inside an SSE
turn — i.e. the user can say "move Stripe to interviewing" in the dock
or the per-document vibe chat and have it land in the kanban.

Permission levels follow agents/harness/permissions:
  list_applications            AUTO    read-only
  move_application             NOTIFY  status change → kanban repaint
  update_application_outcome   NOTIFY  outcome edit

We don't expose a delete / hard-archive tool here. Hard deletes are
APPROVE-grade ops (agent-harness.md §HITL) and the web UI doesn't
surface them either, so leaving them out keeps the agent surface and
the human surface in sync.
"""
from __future__ import annotations

import os
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from agents.harness.permissions import mark_auto, mark_notify

# Mirror agents/coordinator/router.py's resolver. We can't import _resolve_pg_dsn
# directly without forming an import cycle (router imports from tools.* via
# nodes/*), so keep the small fallback local. Order:
#   RELAY_PG_DSN → DATABASE_URL → POSTGRES_URL
_PG_DSN_ENV_VARS = ("RELAY_PG_DSN", "DATABASE_URL", "POSTGRES_URL")


def _resolve_pg_dsn() -> str | None:
    for name in _PG_DSN_ENV_VARS:
        v = os.environ.get(name)
        if v:
            return v
    return None


# Status values accepted by the TS PATCH route. Mirrors
# api/src/schemas.ts UpdateApplicationSchema's status enum; we don't import
# from a TS file, so the source of truth is the migration. Kept short on
# purpose so the agent doesn't invent statuses the kanban can't render.
_ALLOWED_STATUSES = {
    "draft",
    "review",
    "submitted",
    "interview",
    "offer",
    "rejected",
    "ghosted",
    # "accepted" / "closed" are also recognised by the UI's status.ts → column
    # mapping. Allow them so the agent can do "mark accepted" without us
    # having to ship a router update first.
    "accepted",
    "closed",
}


@mark_auto
async def list_applications(user_id: UUID, status: str | None = None) -> list[dict[str, Any]]:
    """Read the user's application_drafts, optionally filtered by status.

    Returns rows shaped like the GET /api/applications list — same fields the
    UI consumes, so the agent's mental model and the user's screen stay in
    lockstep. Empty list when no DSN is configured (matches pg_query helper
    behaviour) so the agent can still emit a polite "couldn't reach DB" reply
    rather than crash the turn.
    """
    dsn = _resolve_pg_dsn()
    if not dsn:
        return []

    sql = """
        SELECT ad.id, ad.status, ad.outcome, ad.cover_letter, ad.submitted_at,
               ad.submitted_via, ad.created_at,
               j.company, j.role_title, j.url
        FROM application_drafts ad
        LEFT JOIN jobs j ON ad.job_id = j.id
        WHERE ad.user_id = %s
    """
    params: list[Any] = [str(user_id)]
    if status:
        sql += " AND ad.status = %s"
        params.append(status)
    sql += " ORDER BY ad.created_at DESC LIMIT 200"

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, tuple(params))
            return await cur.fetchall()


@mark_notify
async def move_application(
    user_id: UUID, application_id: UUID, target_status: str
) -> dict[str, Any]:
    """Set status on one row owned by user_id. Returns {ok, id, status} or
    {ok: False, error}.

    The user_id clause keeps row-level isolation honest — we never accept a
    raw application_id without binding the WHERE to the asking user. This
    mirrors api/src/ownership.ts behaviour at the route layer.

    When status flips to 'submitted' we also stamp submitted_at + submitted_via
    so the kanban's "submitted X ago" timestamp lines up with what the route
    would have produced. submitted_via defaults to 'client_extension' to match
    the TS route (api/src/routes/applications.ts:113).
    """
    if target_status not in _ALLOWED_STATUSES:
        return {"ok": False, "error": f"invalid status: {target_status}"}

    dsn = _resolve_pg_dsn()
    if not dsn:
        return {"ok": False, "error": "no pg dsn configured"}

    sets = ["status = %s"]
    params: list[Any] = [target_status]
    if target_status == "submitted":
        sets.append("submitted_at = NOW()")
        sets.append("submitted_via = %s")
        params.append("client_extension")
    params.extend([str(application_id), str(user_id)])

    sql = f"""
        UPDATE application_drafts
        SET {', '.join(sets)}
        WHERE id = %s AND user_id = %s
        RETURNING id, status, submitted_at, submitted_via
    """

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, tuple(params))
            row = await cur.fetchone()
            await conn.commit()
            if not row:
                # No row matched: either the id is wrong, or it belongs to
                # someone else. We don't distinguish (security: same response
                # for both) — the agent will surface a polite "couldn't find
                # that application" message.
                return {"ok": False, "error": "application not found"}
            return {
                "ok": True,
                "id": str(row["id"]),
                "status": row["status"],
                "submitted_at": row["submitted_at"].isoformat() if row["submitted_at"] else None,
                "submitted_via": row["submitted_via"],
            }


@mark_notify
async def update_application_outcome(
    user_id: UUID, application_id: UUID, outcome: str
) -> dict[str, Any]:
    """Set the free-text outcome field. Mirrors the drawer's outcome input.

    Empty string clears the outcome (matches the drawer's "set to empty to
    forget" behaviour). Length is bounded at 200 chars so an over-eager LLM
    can't fill the column with a paragraph.
    """
    outcome = (outcome or "").strip()[:200]

    dsn = _resolve_pg_dsn()
    if not dsn:
        return {"ok": False, "error": "no pg dsn configured"}

    sql = """
        UPDATE application_drafts
        SET outcome = %s
        WHERE id = %s AND user_id = %s
        RETURNING id, outcome
    """
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, (outcome or None, str(application_id), str(user_id)))
            row = await cur.fetchone()
            await conn.commit()
            if not row:
                return {"ok": False, "error": "application not found"}
            return {"ok": True, "id": str(row["id"]), "outcome": row["outcome"]}
