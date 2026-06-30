"""Dock Agent — main-loop ReAct agent for the Ask Vantage dock (AG-UI).

Design reference:
  - docs/architecture/agent-event-stream.md (AG-UI event stream protocol)
  - docs/design/chat-agent-system-redesign.md §5.1 (P0-A) + §5.2 (P0-B)

Caller:
  - ``agents.api.server.ask_stream`` calls ``run_dock_turn`` and streams the
    yielded SSE frame strings straight through ``_with_heartbeat``.

What changed in PR2 (AG-UI cutover):
  The old hand-rolled ``DockEvent`` → 13-name SSE protocol is gone. We now run
  the dock graph through the official ``ag_ui_langgraph.LangGraphAgent`` adapter,
  which emits the 16 standard AG-UI events (RUN_STARTED / REASONING_* /
  TEXT_MESSAGE_* / TOOL_CALL_* / RUN_FINISHED …) verbatim from the LangGraph
  stream. ``run_dock_turn`` wraps that adapter to:

    1. Inject the Relay envelope (id / seq / trace_id / run_id / thread_id /
       protocol_version) into every event's ``raw_event`` via ``RelayEmitter``
       so the web reducer can de-dup / order / aggregate by step.
    2. Derive Relay product-semantic CUSTOM events (``relay.task_graph`` /
       ``relay.narrator`` / ``relay.agent_start`` / ``relay.agent_done`` /
       ``relay.artifact``) by watching the adapter's TOOL_CALL_START /
       TOOL_CALL_RESULT pairs — the SDK has no notion of "a plan" or "an
       artifact card", those are Relay concepts layered on top.
    3. Handle HITL on the double track: when the graph parks on ``interrupt()``
       the adapter surfaces a CUSTOM ``on_interrupt`` event; we re-emit it as
       ``relay.hitl_prep`` (so the dock can render the approval card) followed
       by a ``RUN_FINISHED`` with ``outcome=interrupt`` (so the run cleanly
       ends and the client knows to collect a decision). Resume is a *new*
       ``run_dock_turn`` call with ``command={"resume": ...}``.

Concurrency: ``max_concurrency=1`` is forced in the run config to side-step
ag-ui-langgraph #871 (concurrent tool-call events arriving out of order /
dropped). The dock's ReAct loop is sequential in practice anyway; this just
makes the guarantee explicit.

Notes on harness wiring (unchanged from before):
  - ``post_model_hook`` (token / cost guards) and ``dock_pre_model_hook``
    (iteration budget + context compaction) stay registered on the graph.
  - Same PostgresSaver as the rest of the agent layer
    (``harness.checkpointer.get_checkpointer``) so HITL ``interrupt()`` resumes
    cleanly across the lifetime per-user thread.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import uuid4

import structlog
from ag_ui.core import (
    BaseEvent,
    EventType,
    Interrupt,
    RunAgentInput,
)
from ag_ui.core import (
    SystemMessage as AGUISystemMessage,
)
from ag_ui.core import (
    UserMessage as AGUIUserMessage,
)
from ag_ui_langgraph import LangGraphAgent, LangGraphEventTypes
from langgraph.prebuilt import create_react_agent
from ulid import ULID

from agents.coordinator.dock_tools import DOCK_TOOLS
from agents.harness.checkpointer import get_checkpointer
from agents.harness.context import dock_pre_model_hook
from agents.harness.events import RelayEmitter
from agents.harness.guards import post_model_hook
from agents.harness.llm import pick_model

log = structlog.get_logger("agents.coordinator.dock_agent")


DOCK_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "coordinator" / "dock_agent.v1.md"

# Adapter "agent name" — purely a label the SDK stamps on its run metadata.
_DOCK_AGENT_NAME = "vantage_dock"

# Tools whose TOOL_CALL_* events are *cosmetic* in the dock UI: they each have a
# dedicated Relay product surface (task-graph card / narrator chip / recall
# inline summary) so we suppress the generic agent_start/agent_done/artifact
# derivation for them. Kept in sync with the gateway's old _CONSOLE_HIDDEN_TOOLS.
_SYSTEM_TOOLS: frozenset[str] = frozenset(
    {
        "propose_plan",
        "narrate",
        "ask_clarification",
        "recall_user_memory",
        "recall_past_applications",
        "recall_weak_points",
    }
)

# Mapping of execution-tool name → (agent, action). Used to derive the
# ``relay.agent_start`` / ``relay.agent_done`` / ``relay.artifact`` CUSTOM
# events so the dock can label the agent row + build the artifact card. Mirrors
# the gateway's old _TOOL_AGENT_MAP.
_TOOL_AGENT_MAP: dict[str, tuple[str, str]] = {
    "list_my_applications": ("applications", "list"),
    "read_resume": ("resume_agent", "read"),
    "tailor_resume": ("resume_agent", "customize"),
    "polish_bullet": ("resume_agent", "polish_bullet"),
    "find_jobs": ("jobmatch_agent", "find_matches"),
    "start_mock_interview": ("interview_agent", "build_mock_graph"),
    "draft_cover_letter": ("appprep_agent", "draft_cover_letter"),
    "build_resume_from_scratch": ("resume_agent", "build_from_scratch"),
    "trends_today": ("trend_agent", "daily_snapshot"),
    "web_search": ("coordinator", "web_search"),
    "web_fetch": ("coordinator", "web_fetch"),
}

# Tool result body cap. Anything larger gets stringified to this limit and
# suffixed with "…[truncated]" so a single 100k-row find_matches dump can't
# bloat an SSE frame. 8 KiB matches what the dock JsonBlock renders.
_TOOL_RESULT_CAP_BYTES = 8 * 1024


@lru_cache(maxsize=1)
def _load_dock_prompt() -> str:
    try:
        return DOCK_PROMPT_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        # Defensive: tests sometimes patch the prompt path; surface as empty
        # rather than crash so the dock still has a model session to fall back
        # on (the LLM gets a less-opinionated system prompt).
        log.warning("dock_agent.prompt_missing", path=str(DOCK_PROMPT_PATH))
        return "You are Vantage. Reply briefly."


@lru_cache(maxsize=4)
def build_dock_graph(tier: str = "general"):
    """Build (and cache) the dock ReAct graph.

    Cached by tier so a future "premium" path can swap the model without
    leaking graphs. Returns the compiled LangGraph, ready to hand to
    ``LangGraphAgent``.
    """
    if tier not in ("heavy", "general", "fast"):
        raise ValueError(f"invalid dock tier: {tier!r}")
    model = pick_model(tier, temperature=0.4, max_tokens=2_048)
    checkpointer = get_checkpointer()
    graph = create_react_agent(
        model=model,
        tools=DOCK_TOOLS,
        prompt=_load_dock_prompt(),
        checkpointer=checkpointer,
        pre_model_hook=dock_pre_model_hook,
        post_model_hook=post_model_hook,
    )
    return graph


async def run_dock_turn(
    *,
    message: str,
    thread_id: str,
    trace_id: str | None = None,
    extra_system_blocks: list[str] | None = None,
    command: dict[str, Any] | None = None,
    recursion_limit: int = 24,
    tier: str = "general",
    graph_factory=None,
) -> AsyncIterator[str]:
    """Yield encoded AG-UI SSE frame strings for one dock turn.

    The caller (``agents.api.server.ask_stream``) is responsible for:
      - regex fast-path (skip this when a cheap classifier is confident)
      - setting the dock contextvars via ``dock_tools.set_dock_context``
        *before* calling this generator
      - wrapping the output in the heartbeat generator + StreamingResponse

    ``extra_system_blocks`` are prepended as AG-UI system messages for
    surface-specific context (locale directive, résumé brief). They feed the
    LangGraph state via the adapter's message merge.

    ``command`` resumes a parked interrupt: pass ``{"resume": <decision>}`` and
    it is forwarded to the adapter as ``forwarded_props.command``, which the SDK
    turns into ``Command(resume=...)``. When ``command`` is set ``message`` may
    be empty (the resume decision drives the turn).

    ``graph_factory`` is a test seam — a zero-arg callable returning a pre-wired
    graph (mock model + MemorySaver). Production leaves it ``None``.

    Yields ``"data: {...}\\n\\n"`` SSE frames. ``ask_stream`` forwards them
    verbatim; the Bun gateway passes them through untouched.
    """
    graph = graph_factory() if graph_factory else build_dock_graph(tier=tier)
    run_id = str(ULID())
    tid = trace_id or str(uuid4())
    emitter = RelayEmitter(run_id=run_id, thread_id=thread_id, trace_id=tid)

    adapter = LangGraphAgent(
        name=_DOCK_AGENT_NAME,
        graph=graph,
        # max_concurrency=1 hard-guards ag-ui-langgraph #871; thread_id pins the
        # checkpointer so HITL resume lands on the same lifetime thread.
        config={
            "max_concurrency": 1,
            "recursion_limit": recursion_limit,
            "configurable": {"thread_id": thread_id},
        },
    )

    messages: list[Any] = []
    for blk in extra_system_blocks or []:
        if blk:
            messages.append(AGUISystemMessage(id=str(ULID()), role="system", content=blk))
    if message:
        messages.append(AGUIUserMessage(id=str(ULID()), role="user", content=message))

    forwarded_props: dict[str, Any] = {}
    if command:
        forwarded_props["command"] = command

    run_input = RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=messages,
        tools=[],
        context=[],
        forwarded_props=forwarded_props,
    )

    # Derivation state across the run.
    tracker = _ToolTracker()
    saw_interrupt = False

    async for event in adapter.run(run_input):
        # The SDK surfaces interrupts as a CUSTOM event named "on_interrupt".
        # Translate that to the Relay double-track (hitl_prep CUSTOM + a
        # RUN_FINISHED interrupt outcome) and swallow the adapter's own
        # RUN_FINISHED so the client sees exactly one terminal frame.
        if _is_interrupt_event(event):
            saw_interrupt = True
            for frame in _emit_hitl(emitter, event):
                yield frame
            continue
        if saw_interrupt and event.type == EventType.RUN_FINISHED:
            # Already emitted our interrupt RUN_FINISHED — drop the SDK's.
            continue

        # Stamp the Relay envelope onto whatever the adapter produced, then
        # encode + yield. _encode_with_envelope mutates raw_event in place.
        yield _encode_with_envelope(emitter, event)

        # Derive Relay product CUSTOM events around tool calls.
        for frame in _derive_custom_events(emitter, event, tracker):
            yield frame


# ---------------------------------------------------------------------------
# Partial-artifact stream (Step 5) — tools call this from inside the graph.
# ---------------------------------------------------------------------------


async def emit_partial_artifact(
    *,
    artifact_id: str,
    kind: str,
    progress: float | None = None,
    title: str | None = None,
    sub: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Stream an in-progress artifact snapshot from inside a LangGraph tool.

    Dispatches a LangGraph custom event named ``relay.partial_artifact``; the
    ag-ui-langgraph adapter forwards it verbatim as an AG-UI CUSTOM event, so
    the dock merges the snapshots into one live card by ``artifact_id``.

    No-op outside a LangGraph callback context (tests / REPL).
    """
    from langchain_core.callbacks.manager import adispatch_custom_event

    data: dict[str, Any] = {"artifact_id": artifact_id, "kind": kind}
    if progress is not None:
        data["progress"] = max(0.0, min(1.0, float(progress)))
    if title is not None:
        data["title"] = str(title)[:200]
    if sub is not None:
        data["sub"] = str(sub)[:200]
    if payload is not None:
        data["payload"] = payload
    try:
        await adispatch_custom_event("relay.partial_artifact", data)
    except RuntimeError:
        # Outside a callback context (no run_manager). Treat as no-op.
        log.debug("emit_partial_artifact.no_runner", artifact_id=artifact_id)


# ---------------------------------------------------------------------------
# Internals — envelope injection, custom-event derivation, HITL.
# ---------------------------------------------------------------------------


class _ToolTracker:
    """Per-run map of tool_call_id → tool name, plus a plan ordinal cursor.

    Lets us label a TOOL_CALL_RESULT (which only carries tool_call_id) with the
    tool name from the matching TOOL_CALL_START, and assign each execution tool
    a monotonic plan_step ordinal so the dock can light up plan rows in order.
    """

    def __init__(self) -> None:
        self._names: dict[str, str] = {}
        self._step_seq = 0

    def remember(self, tool_call_id: str, name: str) -> None:
        if tool_call_id and name:
            self._names[tool_call_id] = name

    def name_for(self, tool_call_id: str) -> str:
        return self._names.get(tool_call_id, "")

    def next_step_id(self) -> str:
        self._step_seq += 1
        return f"step-{self._step_seq}"


def _encode_with_envelope(emitter: RelayEmitter, event: BaseEvent) -> str:
    """Stamp the Relay envelope onto an adapter event and SSE-encode it.

    The adapter already set ``event.raw_event`` to its own LangGraph context.
    We *merge* the Relay envelope into it (keeping the SDK's debug payload under
    ``_langgraph``) so both the SDK's context and our de-dup/order keys travel
    together.
    """
    base = event.raw_event if isinstance(event.raw_event, dict) else None
    relay_meta = emitter._meta()
    if base:
        event.raw_event = {**relay_meta, "_langgraph": base}
    else:
        event.raw_event = relay_meta
    if event.timestamp is None:
        event.timestamp = int(time.time() * 1000)
    return emitter._encoder.encode(event)


def _is_interrupt_event(event: BaseEvent) -> bool:
    return (
        event.type == EventType.CUSTOM
        and getattr(event, "name", None) == LangGraphEventTypes.OnInterrupt.value
    )


def _emit_hitl(emitter: RelayEmitter, event: BaseEvent) -> list[str]:
    """Translate the adapter's on_interrupt CUSTOM into the Relay HITL track.

    Double track (per plan + agent-harness.md HITL design):
      1. ``relay.hitl_prep`` CUSTOM — carries the interrupt payload so the dock
         renders the ask_user / diff / approval card.
      2. ``RUN_FINISHED`` with ``outcome=interrupt`` — terminates the run; the
         client collects a decision and resumes via a new turn with
         ``command={"resume": ...}``.
    """
    # The SDK serialises the LangGraph interrupt value to a JSON string via
    # dump_json_safe — decode it back to a dict so the dock gets structured
    # data and our reason/message classifiers can read its fields.
    value = _decode_tool_content(getattr(event, "value", None))
    interrupt_id = str(ULID())
    reason = _interrupt_reason(value)
    return [
        emitter.emit_custom("relay.hitl_prep", value, step_id=interrupt_id),
        emitter.emit_run_finished_interrupt(
            [
                Interrupt(
                    id=interrupt_id,
                    reason=reason,
                    message=_interrupt_message(value),
                    metadata=value if isinstance(value, dict) else None,
                )
            ]
        ),
    ]


def _interrupt_reason(value: Any) -> str:
    """Best-effort classification of the interrupt for the dock to branch on."""
    if isinstance(value, dict):
        kind = value.get("kind")
        if isinstance(kind, str) and kind:
            return kind
        if "before" in value and "after" in value:
            return "diff"
        if "question" in value:
            return "ask_user"
        if "action" in value:
            return "approval"
    return "approval"


def _interrupt_message(value: Any) -> str | None:
    if isinstance(value, dict):
        for key in ("message", "question", "summary"):
            v = value.get(key)
            if isinstance(v, str) and v:
                return v[:500]
    return None


def _derive_custom_events(
    emitter: RelayEmitter, event: BaseEvent, tracker: _ToolTracker
) -> list[str]:
    """Emit Relay product CUSTOM events around the adapter's tool-call events.

    - TOOL_CALL_START: remember tool_call_id → name; for non-system execution
      tools, emit ``relay.agent_start`` (so the dock shows the agent row).
    - TOOL_CALL_RESULT: decode the tool body; emit ``relay.task_graph`` for
      propose_plan, ``relay.narrator`` for narrate, otherwise
      ``relay.agent_done`` + ``relay.artifact`` for execution tools.
    """
    if event.type == EventType.TOOL_CALL_START:
        tool_call_id = getattr(event, "tool_call_id", "") or ""
        name = getattr(event, "tool_call_name", "") or ""
        tracker.remember(tool_call_id, name)
        if name and name not in _SYSTEM_TOOLS:
            agent, action = _TOOL_AGENT_MAP.get(name, ("coordinator", name))
            step_id = tracker.next_step_id()
            return [
                emitter.emit_custom(
                    "relay.agent_start",
                    {"agent": agent, "action": action, "tool": name},
                    step_id=step_id,
                    extra={"agent": agent, "tool": name},
                )
            ]
        return []

    if event.type == EventType.TOOL_CALL_RESULT:
        tool_call_id = getattr(event, "tool_call_id", "") or ""
        name = tracker.name_for(tool_call_id)
        decoded = _decode_tool_content(getattr(event, "content", None))
        return _custom_for_tool_result(emitter, name, decoded)

    return []


def _custom_for_tool_result(emitter: RelayEmitter, name: str, decoded: Any) -> list[str]:
    if name == "propose_plan" and isinstance(decoded, dict):
        return [emitter.emit_custom("relay.task_graph", decoded)]

    if name == "narrate" and isinstance(decoded, dict):
        text = str(decoded.get("narration") or "").strip()
        if not text:
            return []
        return [emitter.emit_custom("relay.narrator", {"text": text[:160]})]

    if name in _SYSTEM_TOOLS or not name:
        # recall_* / ask_clarification — no extra product surface here.
        return []

    agent, action = _TOOL_AGENT_MAP.get(name, ("coordinator", name))
    out = [
        emitter.emit_custom(
            "relay.agent_done",
            {"agent": agent, "action": action, "tool": name},
            extra={"agent": agent, "tool": name},
        )
    ]
    # Execution tools that returned a structured envelope become an artifact
    # card. Pure-text returns are already carried by the standard TEXT_MESSAGE_*
    # stream, so we only build an artifact for dict results.
    if isinstance(decoded, dict):
        out.append(
            emitter.emit_custom(
                "relay.artifact",
                {
                    "agent": agent,
                    "action": action,
                    "tool": name,
                    "result": _cap_for_wire(decoded),
                },
                extra={"agent": agent},
            )
        )
    return out


def _decode_tool_content(content: Any) -> Any:
    """Decode an AG-UI TOOL_CALL_RESULT.content (str | list | dict) to a dict.

    The adapter serialises tool returns to a string (json.dumps of the dict, or
    a plain string for text returns). Undo that so we can branch on the shape.
    """
    if content is None:
        return None
    if isinstance(content, (dict, list)):
        return content
    if isinstance(content, str):
        s = content.strip()
        if s.startswith("{") or s.startswith("["):
            try:
                return json.loads(s)
            except (ValueError, TypeError):
                return content
        return content
    return content


def _cap_for_wire(value: Any, *, cap_bytes: int = _TOOL_RESULT_CAP_BYTES) -> Any:
    """Cap a tool result so a single SSE frame can't bloat past the limit.

    Values that fit under ``cap_bytes`` pass through unchanged; bigger ones are
    stringified, truncated, and suffixed with the elision marker.
    """
    try:
        encoded = json.dumps(value, default=str)
    except (TypeError, ValueError):
        encoded = str(value)
    if len(encoded.encode("utf-8")) <= cap_bytes:
        return value
    truncated = encoded[:cap_bytes]
    return f"{truncated}…[truncated]"


__all__ = [
    "build_dock_graph",
    "run_dock_turn",
    "emit_partial_artifact",
]
