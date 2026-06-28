"""Cross-graph event handlers (design §6.4 / §9 P2-9 — context flywheel).

These consume Redis Streams events published by the agents and turn them into
follow-up work. Right now there is one handler: when a user accepts a résumé
suggestion, look for other bullets that could take the same improvement and
queue them as fresh proposals.

Run pattern — a long-lived worker process iterates `subscribe(topic)` and awaits
the matching handler per entry:

    async for entry in subscribe("resume:suggestion_accepted"):
        await on_suggestion_accepted(entry["data"])

The proposals land in the persisted `resume_suggestions` stack (status
'proposed'), so the user sees them next time they open the studio or dock via
GET /api/resumes/:id/suggestions — no live server-push to the dock is required.
(A real-time "Vantage proactively pings you" channel needs dock infrastructure
that doesn't exist yet; that's the one piece of §6.4 left for a later pass.)
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import structlog

log = structlog.get_logger("agents.events.handlers")


async def on_suggestion_accepted(data: dict[str, Any]) -> dict[str, Any]:
    """Handle a `resume:suggestion_accepted` event → re-propose similar bullets.

    `data` shape (from resume_agent.apply_suggestions):
      {user_id, source_resume_id, change_type, bullet_stable_id}

    Best-effort: a malformed event or a transient failure is logged, not raised,
    so one bad entry never wedges the worker loop.
    """
    try:
        user_id = UUID(str(data["user_id"]))
        source_resume_id = UUID(str(data["source_resume_id"]))
    except (KeyError, ValueError):
        log.warning("on_suggestion_accepted.bad_event", data=data)
        return {"ok": False, "reason": "bad_event"}

    from agents.nodes import resume_agent

    change_type = data.get("change_type")
    try:
        result = await resume_agent.propose_similar_bullets(
            source_resume_id, user_id, change_type=change_type
        )
    except Exception as exc:  # noqa: BLE001 boundary — never kill the worker
        log.error("on_suggestion_accepted.failed", error=str(exc), kind=type(exc).__name__)
        return {"ok": False, "reason": "handler_error"}

    log.info(
        "on_suggestion_accepted.reproposed",
        user_id=str(user_id),
        proposed=len(result.get("proposed", [])),
    )
    return result


async def run_flywheel_worker() -> None:
    """Long-lived consumer for the context-flywheel topic. Intended to be
    launched as a background task by the FastAPI app or a standalone worker."""
    from agents.events.bus import subscribe

    async for entry in subscribe("resume:suggestion_accepted"):
        await on_suggestion_accepted(entry.get("data", {}))
