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
        event.raw_event = self._meta(step_id=step_id, parent_step_id=parent_step_id, extra=extra)
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
                outcome=RunFinishedInterruptOutcome(type="interrupt", interrupts=interrupt_list),
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


# --------------------------------------------------------------------------- sink
#
# Tools run *inside* the LangGraph ReAct loop and cannot yield SSE frames up to
# FastAPI directly. To let a tool emit a Relay CUSTOM event mid-execution, the
# dock turn binds a "sink" callback (PR2 dock_agent) into a ContextVar before
# invoking the graph; the tool calls emit_custom_event(...) and the sink routes
# the encoded frame onto the live SSE stream.
#
# This mirrors the existing dock_tools._USER_CTX contextvar pattern (a per-turn
# ambient binding the tool reads without exposing it in its JSON schema). When no
# sink is bound — unit tests, or a code path that runs a tool outside a dock turn
# — emit_custom_event is a silent no-op, so tools never crash for lack of a sink.

import contextvars  # noqa: E402 — kept next to the sink API it powers

# A sink receives an already-encoded SSE frame string (the output of
# RelayEmitter.emit_custom). PR2's dock_agent binds one that puts the frame on
# the SSE queue; tests bind a list.append to capture frames.
CustomEventSink = "Callable[[str], None]"  # documented type alias (see emit_custom_event)

_CUSTOM_SINK: contextvars.ContextVar[Any | None] = contextvars.ContextVar(
    "_relay_custom_sink", default=None
)
_CUSTOM_EMITTER: contextvars.ContextVar[RelayEmitter | None] = contextvars.ContextVar(
    "_relay_custom_emitter", default=None
)


def bind_custom_sink(
    emitter: RelayEmitter, sink: Any
) -> tuple[contextvars.Token[Any], contextvars.Token[Any]]:
    """Bind the per-turn emitter + frame sink. Caller MUST reset_custom_sink().

    ``sink`` is a callable taking the encoded SSE frame str (e.g. an SSE queue's
    put_nowait, or list.append in tests).
    """
    return (_CUSTOM_EMITTER.set(emitter), _CUSTOM_SINK.set(sink))


def reset_custom_sink(
    tokens: tuple[contextvars.Token[Any], contextvars.Token[Any]],
) -> None:
    emitter_tok, sink_tok = tokens
    _CUSTOM_EMITTER.reset(emitter_tok)
    _CUSTOM_SINK.reset(sink_tok)


def emit_custom_event(
    name: str,
    value: Any,
    *,
    step_id: str | None = None,
    parent_step_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> str | None:
    """Emit a Relay CUSTOM event from inside a tool, if a sink is bound.

    Returns the encoded frame (also handed to the sink), or None when no sink is
    bound (the tool ran outside a dock turn — a no-op, never an error). The name
    is still validated against the ``relay.`` prefix by RelayEmitter.emit_custom.
    """
    emitter = _CUSTOM_EMITTER.get()
    sink = _CUSTOM_SINK.get()
    if emitter is None or sink is None:
        return None
    frame = emitter.emit_custom(
        name, value, step_id=step_id, parent_step_id=parent_step_id, extra=extra
    )
    sink(frame)
    return frame


__all__ = [
    "RelayEmitter",
    "RELAY_PROTOCOL_VERSION",
    "CustomEventSink",
    "bind_custom_sink",
    "reset_custom_sink",
    "emit_custom_event",
]
