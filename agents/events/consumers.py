"""Application:submitted consumers — flywheel pre-wiring (T8).

Two log-only consumers run in the background so the submit → preheat /
trend-signal plumbing exists from day 1 (Phase 1 flywheel groundwork per
docs/architecture/delivery-loop-plan.md § 2.1 last column):

  - interview_agent_preheat:
      Warm the interview question pool for the company/role of an
      application the user just submitted. Phase 2 will pre-fetch real
      interview history; for now it logs so we can verify the plumbing.

  - trend_agent_signal:
      Drop a row into a signals stream so TrendAgent's nightly ETL knows
      "user X applied to company Y for role Z today". Phase 2 will use
      this to drive the "if you learn X, you'd unlock Y" personalised
      simulator. Today it logs.

Both consumers run as asyncio tasks started by the FastAPI app on startup;
they share the global agents.events.bus.subscribe() generator. They are
deliberately silent on failure — losing one event is acceptable; crashing
the consumer tree because Redis hiccupped is not.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import structlog

from agents.events.bus import subscribe

log = structlog.get_logger("agents.events.consumers")

TOPIC = "application:submitted"


async def interview_agent_preheat(entry: dict) -> None:
    """Phase 1: log only. Phase 2 will fetch crowdsourced interview prep."""
    data = entry.get("data") or {}
    log.info(
        "consumer.interview_preheat",
        entry_id=entry.get("id"),
        user_id=data.get("user_id"),
        company=data.get("company"),
        role=data.get("role_title"),
    )


async def trend_agent_signal(entry: dict) -> None:
    """Phase 1: log only. Phase 2 will write to TrendAgent's DuckDB signals."""
    data = entry.get("data") or {}
    log.info(
        "consumer.trend_signal",
        entry_id=entry.get("id"),
        user_id=data.get("user_id"),
        company=data.get("company"),
        role=data.get("role_title"),
        application_id=data.get("application_id"),
    )


CONSUMERS: list[Callable[[dict], Awaitable[None]]] = [
    interview_agent_preheat,
    trend_agent_signal,
]


async def run_application_submitted_consumers() -> None:
    """Pump entries off the application:submitted stream into each consumer.

    Crashes inside a consumer are swallowed so a buggy consumer can't take
    down the rest. The outer subscribe() also handles Redis-not-available
    by silently returning, so this task is safe to launch even when Redis
    isn't reachable during local dev.
    """
    try:
        async for entry in subscribe(TOPIC):
            for consumer in CONSUMERS:
                try:
                    await consumer(entry)
                except Exception as exc:  # noqa: BLE001 — fan-out boundary
                    log.error(
                        "consumer.failed",
                        consumer=consumer.__name__,
                        error=str(exc),
                    )
    except Exception as exc:  # noqa: BLE001 — task-level safety net
        log.error("consumer.pump_crashed", error=str(exc))


def start_in_background() -> asyncio.Task[None]:
    """Launch the pump as a fire-and-forget task. Caller keeps the handle so
    test code can cancel it cleanly."""
    return asyncio.create_task(
        run_application_submitted_consumers(), name="application_submitted_consumers"
    )


# ─────────────────────────────────────────────────────────────────────
# P1-5: additional cross-agent consumers.
# ─────────────────────────────────────────────────────────────────────
#
# Two new topics complete the "5 agents stop being islands" wiring:
#
#   resume:updated  — emitted by resume_agent (parse, optimize, customize,
#                     apply_suggestions). Triggers jobmatch recomputation:
#                     the user's match scores must reflect the new résumé
#                     content.
#
#   resume:tailored — emitted by resume_agent.customize. Writes a soft
#                     "nudge" memory the dock can recall next turn ("you
#                     just tailored to Stripe Staff — want to prepare a
#                     full submission packet?").


async def jobmatch_recompute_consumer(entry: dict) -> None:
    """When a résumé updates, recompute the user's job matches in the bg.

    Phase 1: log only (jobmatch_agent.find_matches currently runs ad-hoc
    on a /jobs/match request). Phase 2 will warm the matches cache so the
    next find_jobs call from the dock is instant.
    """
    data = entry.get("data") or {}
    log.info(
        "consumer.jobmatch_recompute",
        entry_id=entry.get("id"),
        user_id=data.get("user_id"),
        resume_id=data.get("resume_id"),
        version=data.get("version"),
    )


async def dock_nudge_on_tailored(entry: dict) -> None:
    """When a résumé gets tailored, persist a 'next-step' user memory so the
    dock's next turn can proactively offer to prepare a submission packet.

    Best-effort: failures are logged, not raised. No DSN → no-op.
    """
    import os

    data = entry.get("data") or {}
    user_id = data.get("user_id")
    job_id = data.get("job_id")
    company = data.get("company") or "the role"
    if not user_id:
        return

    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        log.info(
            "consumer.dock_nudge.skipped_no_dsn",
            user_id=user_id,
            company=company,
        )
        return

    try:
        import json

        import psycopg

        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                metadata = {"topic": "tailored"}
                if job_id:
                    metadata["job_id"] = str(job_id)
                # user_memories shape (migration 008): id, user_id, kind,
                # content, metadata, created_at. We tag this memory with
                # kind='nudge' so the dock's recall_user_memory can pull it.
                await cur.execute(
                    """
                    INSERT INTO user_memories (user_id, kind, content, metadata)
                    VALUES (%s, 'nudge', %s, %s::jsonb)
                    """,
                    (
                        str(user_id),
                        (
                            f"Just tailored a résumé for {company}. "
                            "Suggest preparing a submission packet "
                            "(cover letter + form answers) for this job next."
                        ),
                        json.dumps(metadata),
                    ),
                )
            await conn.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "consumer.dock_nudge.failed",
            user_id=user_id,
            error=str(exc),
            kind=type(exc).__name__,
        )


async def _generic_pump(topic: str, consumers: list[Callable[[dict], Awaitable[None]]]) -> None:
    """Pump entries off ``topic`` into each consumer. Fans out errors."""
    try:
        async for entry in subscribe(topic):
            for consumer in consumers:
                try:
                    await consumer(entry)
                except Exception as exc:  # noqa: BLE001
                    log.error(
                        "consumer.failed",
                        topic=topic,
                        consumer=consumer.__name__,
                        error=str(exc),
                    )
    except Exception as exc:  # noqa: BLE001
        log.error("consumer.pump_crashed", topic=topic, error=str(exc))


async def run_resume_updated_consumers() -> None:
    await _generic_pump("resume:updated", [jobmatch_recompute_consumer])


async def run_resume_tailored_consumers() -> None:
    await _generic_pump("resume:tailored", [dock_nudge_on_tailored])


def start_all_in_background() -> list[asyncio.Task[None]]:
    """Launch ALL P1-5 cross-agent consumers as background tasks.

    Returns the task handles so the caller (FastAPI lifespan) can cancel
    them on shutdown. Includes:
      - application:submitted (existing T8 plumbing)
      - resume:updated         (new — jobmatch recompute signal)
      - resume:tailored        (new — dock nudge)
      - resume:suggestion_accepted (existing flywheel worker)
    """
    from agents.events.handlers import run_flywheel_worker

    return [
        asyncio.create_task(
            run_application_submitted_consumers(),
            name="application_submitted_consumers",
        ),
        asyncio.create_task(
            run_resume_updated_consumers(),
            name="resume_updated_consumers",
        ),
        asyncio.create_task(
            run_resume_tailored_consumers(),
            name="resume_tailored_consumers",
        ),
        asyncio.create_task(
            run_flywheel_worker(),
            name="flywheel_worker",
        ),
    ]
