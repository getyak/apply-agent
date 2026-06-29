"""RelayEmitter — Relay 的 AG-UI 事件发射器，负责给 ag-ui-protocol 事件注入 envelope。

See docs/architecture/agent-event-stream.md §5.2 + plan file unified-singing-hearth.md PR1.

Why this layer exists:
- ag-ui-protocol's BaseEvent only carries (type, timestamp, raw_event). Relay needs a stable
  envelope (id / seq / trace_id / run_id / thread_id / step_id / parent_step_id /
  protocol_version) so the web reducer can de-duplicate, order, and aggregate by step.
  Per the SDK's spec extension point, all Relay-specific fields land in event.raw_event.
- CustomEvent name MUST start with "relay." so future AG-UI standard event names cannot
  collide. Runtime-asserted.
- emit() returns the SDK-produced SSE frame string ("data: {...}\\n\\n"). Callers can wrap
  with `event: agui\\n` + `id: <ulid>\\n` if they want browser EventSource reconnection.

Callers: agents/coordinator/dock_agent.py (PR2), agents/tools/browser.py (PR4),
         agents/tools/file.py (PR4).
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from typing import Any

from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
    RunStartedEvent,
)
from ag_ui.encoder import EventEncoder
from ulid import ULID

# Bumped whenever envelope shape inside raw_event changes (independent of ag-ui-protocol semver).
# Web reducer reads event.raw_event.protocol_version to route compatible code paths.
RELAY_PROTOCOL_VERSION = "agui-0.1.19+relay-1"

# All Relay-extended CUSTOM events MUST start with this prefix. Enforced in emit_custom().
_RELAY_CUSTOM_PREFIX = "relay."


class RelayEmitter:
    """Per-run emitter. Inject envelope into raw_event and return SDK-encoded SSE frames.

    One emitter per dock turn (== one AG-UI run). Holds the run_id / thread_id / trace_id
    + a monotonic seq counter shared across every event in this run.
    """

    def __init__(self, *, run_id: str, thread_id: str, trace_id: str) -> None:
        self.run_id = run_id
        self.thread_id = thread_id
        self.trace_id = trace_id
        self._seq = 0
        self._encoder = EventEncoder()

    # ------------------------------------------------------------------ envelope

    def _meta(
        self,
        *,
        step_id: str | None = None,
        parent_step_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build the Relay envelope dict, written into event.raw_event before encoding.

        seq is incremented *here* so every meta call advances it atomically. ULID is
        generated per event so client can de-duplicate even if seq collides across
        adapter-emitted events (which can also write into raw_event).
        """
        self._seq += 1
        meta: dict[str, Any] = {
            "id": str(ULID()),
            "seq": self._seq,
            "trace_id": self.trace_id,
            "run_id": self.run_id,
            "thread_id": self.thread_id,
            "protocol_version": RELAY_PROTOCOL_VERSION,
        }
        if step_id is not None:
            meta["step_id"] = step_id
        if parent_step_id is not None:
            meta["parent_step_id"] = parent_step_id
        if extra:
            # caller-supplied fields win — used e.g. to carry plan_step ordinal, agent name
            meta.update(extra)
        return meta

    # ------------------------------------------------------------------ generic

    def emit(
        self,
        event: BaseEvent,
        *,
        step_id: str | None = None,
        parent_step_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> str:
        """Set timestamp + Relay envelope on a BaseEvent and return SDK-encoded SSE frame.

        Returns: 'data: {...json...}\\n\\n' (str). Caller may concat `event:` / `id:` lines
        if browser-side EventSource Last-Event-Id reconnection is desired.
        """
        event.timestamp = int(time.time() * 1000)
        event.raw_event = self._meta(
            step_id=step_id, parent_step_id=parent_step_id, extra=extra
        )
        return self._encoder.encode(event)

    # ------------------------------------------------------------------ helpers

    def emit_run_started(
        self,
        *,
        parent_run_id: str | None = None,
        input: Any = None,
    ) -> str:
        return self.emit(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=self.thread_id,
                run_id=self.run_id,
                parent_run_id=parent_run_id,
                input=input,
            )
        )

    def emit_run_finished_success(self, *, result: Any | None = None) -> str:
        return self.emit(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=self.thread_id,
                run_id=self.run_id,
                result=result,
                outcome=RunFinishedSuccessOutcome(type="success"),
            )
        )

    def emit_run_finished_interrupt(self, interrupts: Iterable[Any]) -> str:
        """Used when LangGraph paused on interrupt() — turn ends with outcome=interrupt.

        Resume is a *new* run with Command(resume=...) — see PR2 dock_agent.run_dock_turn.
        """
        interrupt_list = list(interrupts)
        if not interrupt_list:
            raise ValueError("emit_run_finished_interrupt requires at least one interrupt")
        return self.emit(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=self.thread_id,
                run_id=self.run_id,
                outcome=RunFinishedInterruptOutcome(
                    type="interrupt", interrupts=interrupt_list
                ),
            )
        )

    def emit_run_error(self, *, message: str, code: str | None = None) -> str:
        return self.emit(
            RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=message,
                code=code,
            )
        )

    def emit_custom(
        self,
        name: str,
        value: Any,
        *,
        step_id: str | None = None,
        parent_step_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> str:
        """Emit a Relay CUSTOM event. Name MUST start with 'relay.'.

        See docs/architecture/agent-event-stream.md §3.3 for the registry of allowed
        Relay CUSTOM names (relay.task_graph, relay.artifact, relay.browser_snapshot,
        relay.file_edit, relay.hitl_prep, …).
        """
        if not name.startswith(_RELAY_CUSTOM_PREFIX):
            raise ValueError(
                f"Relay CUSTOM event name must start with {_RELAY_CUSTOM_PREFIX!r}, got: {name!r}"
            )
        return self.emit(
            CustomEvent(type=EventType.CUSTOM, name=name, value=value),
            step_id=step_id,
            parent_step_id=parent_step_id,
            extra=extra,
        )

    # ------------------------------------------------------------------ debug

    @property
    def seq(self) -> int:
        """Current seq counter (number of events emitted so far in this run)."""
        return self._seq


__all__ = ["RelayEmitter", "RELAY_PROTOCOL_VERSION"]
