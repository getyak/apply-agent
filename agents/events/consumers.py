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
