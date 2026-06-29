"""File-edit tools — emit a preview, write, then confirm.

Currently one tool: ``edit_resume_bullet``. It rewrites a single
``work[].highlights[]`` bullet, addressed by its stable id from the résumé's
``bullet_index`` (migration 017). The three-beat sequence is the whole point —
it's what gives the dock a live diff card:

  1. emit ``relay.file_edit.preview``  {path, before, after}   ← dock renders diff
  2. write the new bullet into resumes.content (PG)
  3. emit ``relay.file_edit``          {path, hunks, applied}  ← dock marks applied

Permission: NOTIFY. The edit is reversible (résumés are versioned + the diff is
shown before-and-after), so it doesn't need the hard HITL gate that browser
writes do. The user sees the diff card and can reject in the UI.

Red line (vision.md): this tool only *rewrites* existing bullets — it never
invents a new one. Originals are immutable (the 017 ``prevent_original_mutation``
trigger), so editing an original-track résumé is refused up front with a clear
message rather than letting the DB raise.
"""

from __future__ import annotations

import json
import re
from typing import Any
from uuid import UUID

import psycopg
import structlog

from agents.harness.events import emit_custom_event
from agents.harness.permissions import mark_notify
from agents.nodes.resume_store import _dsn, get_resume, unwrap_parsed

log = structlog.get_logger("agents.tools.file")


def _resolve_path(
    parsed: dict[str, Any], bullet_index: dict[str, Any], stable_id: str
) -> tuple[int, int] | None:
    """Resolve a stable bullet id to (work_index, highlight_index).

    Trusts the recorded ``path`` only when the slot still holds the same text
    (anchor_text prefix match) — guards against the LLM having reshuffled the
    highlights array since the index was pinned (resume_agent._find_bullet §10 Q3).
    """
    entry = (bullet_index or {}).get(stable_id)
    if not entry:
        return None
    m = re.match(r"work\.(\d+)\.highlights\.(\d+)", entry.get("path", ""))
    if not m:
        return None
    wi, hi = int(m.group(1)), int(m.group(2))
    try:
        cur = parsed["work"][wi]["highlights"][hi]
    except (KeyError, IndexError, TypeError):
        return None
    anchor = (entry.get("anchor_text") or "").strip().lower()
    cur_text = (cur if isinstance(cur, str) else str(cur)).strip().lower()
    if anchor and not cur_text.startswith(anchor[:32]):
        # The recorded slot now holds a different bullet — refuse rather than
        # silently overwrite the wrong line.
        return None
    return wi, hi


@mark_notify
async def edit_resume_bullet(
    resume_id: UUID,
    user_id: UUID,
    bullet_id: str,
    new_text: str,
) -> dict[str, Any]:
    """Rewrite one résumé bullet, streaming a preview→apply diff to the dock.

    Returns a structured result dict; never raises on the expected failure
    paths (résumé not found, bullet unresolved, original immutable) — each comes
    back as ``{"status": "error", ...}`` so the dock can render a friendly card.
    """
    path_str = f"resume:{resume_id}#{bullet_id}"

    record = await get_resume(resume_id, user_id)
    if record is None:
        return {"status": "error", "reason": "resume_not_found", "path": path_str}

    if record.get("track") == "original":
        # 017 trigger would reject the UPDATE; refuse early with a clear reason.
        return {"status": "error", "reason": "original_immutable", "path": path_str}

    content = record["content"]
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            return {"status": "error", "reason": "content_unparseable", "path": path_str}

    parsed = unwrap_parsed(content)
    loc = _resolve_path(parsed, record.get("bullet_index") or {}, bullet_id)
    if loc is None:
        return {"status": "error", "reason": "bullet_not_found", "path": path_str}
    wi, hi = loc
    before = parsed["work"][wi]["highlights"][hi]
    before = before if isinstance(before, str) else str(before)

    # 1. Preview — dock renders the diff before anything is written.
    emit_custom_event(
        "relay.file_edit.preview",
        {"path": path_str, "before": before, "after": new_text},
    )

    # 2. Apply — write the new bullet back into resumes.content.
    parsed["work"][wi]["highlights"][hi] = new_text
    # Preserve the stored envelope shape: if content wrapped parsed under
    # "parsed", write it back there; otherwise the doc IS the content.
    if isinstance(content, dict) and isinstance(content.get("parsed"), dict):
        content["parsed"] = parsed
        new_content = content
    else:
        new_content = parsed

    sql = "UPDATE resumes SET content = %s WHERE id = %s AND user_id = %s"
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, (json.dumps(new_content), str(resume_id), str(user_id)))
            updated = cur.rowcount
        await conn.commit()

    if updated == 0:
        return {"status": "error", "reason": "write_failed", "path": path_str}

    # 3. Final — dock marks the edit applied.
    emit_custom_event(
        "relay.file_edit",
        {
            "path": path_str,
            "language": "markdown",
            "hunks": [{"before": before, "after": new_text}],
            "applied": True,
        },
    )

    return {
        "status": "ok",
        "action": "edit_resume_bullet",
        "path": path_str,
        "bullet_id": bullet_id,
    }


__all__ = ["edit_resume_bullet"]
