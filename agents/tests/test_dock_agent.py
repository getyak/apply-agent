"""Tests for the AG-UI Dock agent (agents.coordinator.dock_agent).

PR2 cutover: dock_agent now runs the dock graph through ag_ui_langgraph's
``LangGraphAgent`` adapter and yields *encoded AG-UI SSE frame strings*. The
old hand-rolled ``DockEvent`` / ``_translate_event`` system is gone.

We stub the LLM with ``FakeMessagesListChatModel`` so we can script tool-use
sequences without hitting OpenRouter. Each test verifies one slice of the new
contract:
  - the run emits the standard AG-UI lifecycle (RUN_STARTED … RUN_FINISHED)
  - propose_plan / narrate / execution tools are translated into the Relay
    ``relay.*`` CUSTOM events (task_graph / narrator / agent_start / agent_done
    / artifact)
  - every frame carries the Relay envelope (id / seq / trace_id / run_id /
    protocol_version) in rawEvent
  - HITL: an interrupt yields ``relay.hitl_prep`` + RUN_FINISHED(interrupt)
  - resume via ``command={"resume": ...}`` completes the parked turn
  - the small pure helpers (_decode_tool_content / _cap_for_wire /
    _interrupt_reason / _custom_for_tool_result) behave correctly
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import create_react_agent

from agents.coordinator import dock_agent, dock_tools
from agents.harness.events import RELAY_PROTOCOL_VERSION, RelayEmitter


class _ScriptedChat(FakeMessagesListChatModel):
    """Subclass to bypass pydantic frozen-field restriction on bind_tools."""

    def bind_tools(self, *_a, **_kw):  # noqa: D401 — overrides ABC stub
        return self


def _scripted_chat(responses: list[AIMessage]) -> _ScriptedChat:
    return _ScriptedChat(responses=responses)


def _build_test_graph(model: FakeMessagesListChatModel):
    """Compile a dock-style graph with a MemorySaver and the real DOCK_TOOLS."""
    return create_react_agent(
        model=model,
        tools=dock_tools.DOCK_TOOLS,
        prompt="You are Vantage. Plan first, then execute.",
        checkpointer=MemorySaver(),
    )


def _parse_frames(frames: list[str]) -> list[dict]:
    """Decode the AG-UI SSE frame strings into a flat list of event dicts."""
    out: list[dict] = []
    for frame in frames:
        for line in frame.split("\n"):
            if not line.startswith("data:"):
                continue
            try:
                out.append(json.loads(line[5:].strip()))
            except (ValueError, TypeError):
                continue
    return out


async def _collect(gen) -> list[str]:
    return [frame async for frame in gen]


# ───────────────────────────────────────────────────────────── end-to-end run


@pytest.mark.asyncio
async def test_run_dock_turn_emits_lifecycle_plan_and_artifact(monkeypatch):
    """Scripted LLM (plan → exec → reply): the run yields the AG-UI lifecycle
    plus the derived relay.task_graph / agent_start / agent_done / artifact."""
    _ = monkeypatch

    plan_call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "propose_plan",
                "args": {
                    "user_goal": "List my pipeline",
                    "steps": [{"step": "list", "agent": "applications", "label": "List apps"}],
                },
                "id": "tc-1",
            }
        ],
    )
    exec_call = AIMessage(
        content="",
        tool_calls=[{"name": "list_my_applications", "args": {"limit": 5}, "id": "tc-2"}],
    )
    final = AIMessage(content="You have 1 application in flight.")
    graph = _build_test_graph(_scripted_chat([plan_call, exec_call, final]))

    user_id = uuid4()
    thread_id = f"ask_vantage:{user_id}"
    tokens = dock_tools.set_dock_context(user_id=user_id, thread_id=thread_id, surface="dock")
    try:
        with patch(
            "agents.tools.applications.list_applications",
            new=AsyncMock(
                return_value=[
                    {
                        "id": "11111111-1111-1111-1111-111111111111",
                        "company": "Stripe",
                        "role_title": "Staff Eng",
                        "status": "interview",
                    }
                ]
            ),
        ):
            frames = await _collect(
                dock_agent.run_dock_turn(
                    message="What's in my pipeline?",
                    thread_id=thread_id,
                    trace_id="trace-1",
                    graph_factory=lambda: graph,
                    recursion_limit=20,
                )
            )
    finally:
        dock_tools.reset_dock_context(tokens)

    events = _parse_frames(frames)
    types = [e.get("type") for e in events]
    assert "RUN_STARTED" in types
    assert "RUN_FINISHED" in types
    assert "TOOL_CALL_START" in types
    assert "TOOL_CALL_RESULT" in types

    custom_names = [e.get("name") for e in events if e.get("type") == "CUSTOM"]
    assert "relay.task_graph" in custom_names
    assert "relay.agent_start" in custom_names
    assert "relay.agent_done" in custom_names
    assert "relay.artifact" in custom_names

    # task_graph carries the plan the propose_plan tool returned.
    tg = next(e for e in events if e.get("name") == "relay.task_graph")
    assert tg["value"]["plan_id"]
    assert tg["value"]["plan"][0]["agent"] == "applications"

    # artifact carries the agent + the tool result.
    art = next(e for e in events if e.get("name") == "relay.artifact")
    assert art["value"]["agent"] == "applications"
    assert art["value"]["action"] == "list"


@pytest.mark.asyncio
async def test_run_dock_turn_envelope_on_every_frame():
    """Every emitted frame carries the Relay envelope in rawEvent."""
    final = AIMessage(content="Hi, I'm Vantage.")
    graph = _build_test_graph(_scripted_chat([final]))

    user_id = uuid4()
    thread_id = f"ask_vantage:{user_id}"
    tokens = dock_tools.set_dock_context(user_id=user_id, thread_id=thread_id, surface="dock")
    try:
        frames = await _collect(
            dock_agent.run_dock_turn(
                message="hi",
                thread_id=thread_id,
                trace_id="trace-xyz",
                graph_factory=lambda: graph,
            )
        )
    finally:
        dock_tools.reset_dock_context(tokens)

    events = _parse_frames(frames)
    assert events, "no events emitted"
    seqs: list[int] = []
    for e in events:
        raw = e.get("rawEvent") or {}
        assert raw.get("trace_id") == "trace-xyz", e
        assert raw.get("run_id"), e
        assert raw.get("thread_id") == thread_id, e
        assert raw.get("protocol_version") == RELAY_PROTOCOL_VERSION, e
        assert isinstance(raw.get("seq"), int), e
        seqs.append(raw["seq"])
    # seq is strictly monotonic across the whole run.
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)


@pytest.mark.asyncio
async def test_run_dock_turn_narrator_custom_event():
    """A narrate() call surfaces as a relay.narrator CUSTOM event."""
    narr_call = AIMessage(
        content="",
        tool_calls=[{"name": "narrate", "args": {"thought": "Checking your pipeline."}, "id": "n1"}],
    )
    final = AIMessage(content="Done.")
    graph = _build_test_graph(_scripted_chat([narr_call, final]))

    user_id = uuid4()
    thread_id = f"ask_vantage:{user_id}"
    tokens = dock_tools.set_dock_context(user_id=user_id, thread_id=thread_id, surface="dock")
    try:
        frames = await _collect(
            dock_agent.run_dock_turn(
                message="anything", thread_id=thread_id, graph_factory=lambda: graph
            )
        )
    finally:
        dock_tools.reset_dock_context(tokens)

    events = _parse_frames(frames)
    narrators = [e for e in events if e.get("name") == "relay.narrator"]
    assert len(narrators) == 1
    assert narrators[0]["value"]["text"] == "Checking your pipeline."


@pytest.mark.asyncio
async def test_run_dock_turn_recall_tool_no_artifact():
    """recall_* tools are system tools — they emit no agent_start/artifact."""
    recall_call = AIMessage(
        content="",
        tool_calls=[{"name": "recall_user_memory", "args": {"query": "prefs"}, "id": "r1"}],
    )
    final = AIMessage(content="No memory yet.")
    graph = _build_test_graph(_scripted_chat([recall_call, final]))

    user_id = uuid4()
    thread_id = f"ask_vantage:{user_id}"
    tokens = dock_tools.set_dock_context(user_id=user_id, thread_id=thread_id, surface="dock")
    try:
        with patch(
            "agents.tools.auto.pg_query",
            new=AsyncMock(side_effect=RuntimeError("PG offline")),
        ):
            frames = await _collect(
                dock_agent.run_dock_turn(
                    message="what do you remember?",
                    thread_id=thread_id,
                    graph_factory=lambda: graph,
                )
            )
    finally:
        dock_tools.reset_dock_context(tokens)

    events = _parse_frames(frames)
    custom_names = [e.get("name") for e in events if e.get("type") == "CUSTOM"]
    assert "relay.agent_start" not in custom_names
    assert "relay.artifact" not in custom_names
    # The standard tool-call lifecycle still flows for the recall tool.
    assert "TOOL_CALL_RESULT" in [e.get("type") for e in events]


# ─────────────────────────────────────────────────────────────────────── HITL


@pytest.mark.asyncio
async def test_run_dock_turn_interrupt_double_track():
    """ask_clarification → relay.hitl_prep CUSTOM + RUN_FINISHED(interrupt)."""
    ask_call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "ask_clarification",
                "args": {"question": "Which job?", "options": ["Stripe", "Linear"]},
                "id": "tc-1",
            }
        ],
    )
    final = AIMessage(content="Tailoring for Stripe.")
    graph = _build_test_graph(_scripted_chat([ask_call, final]))

    user_id = uuid4()
    thread_id = f"ask_vantage:{user_id}"
    tokens = dock_tools.set_dock_context(user_id=user_id, thread_id=thread_id, surface="dock")
    try:
        frames = await _collect(
            dock_agent.run_dock_turn(
                message="tailor for me", thread_id=thread_id, graph_factory=lambda: graph
            )
        )
    finally:
        dock_tools.reset_dock_context(tokens)

    events = _parse_frames(frames)
    prep = [e for e in events if e.get("name") == "relay.hitl_prep"]
    assert len(prep) == 1
    # value is decoded back to a dict (SDK serialises the interrupt to a string).
    assert prep[0]["value"]["kind"] == "clarification"
    assert prep[0]["value"]["question"] == "Which job?"

    finished = [e for e in events if e.get("type") == "RUN_FINISHED"]
    # Exactly one terminal frame — our interrupt RUN_FINISHED, the SDK's own is
    # swallowed.
    assert len(finished) == 1
    outcome = finished[0]["outcome"]
    assert outcome["type"] == "interrupt"
    interrupt = outcome["interrupts"][0]
    assert interrupt["id"]
    assert interrupt["reason"] == "clarification"
    assert interrupt["message"] == "Which job?"


@pytest.mark.asyncio
async def test_run_dock_turn_resume_completes_parked_turn():
    """A resume turn with command={'resume': ...} continues the parked graph."""
    ask_call = AIMessage(
        content="",
        tool_calls=[
            {"name": "ask_clarification", "args": {"question": "Which job?"}, "id": "tc-1"}
        ],
    )
    final = AIMessage(content="Got it — Stripe it is.")
    graph = _build_test_graph(_scripted_chat([ask_call, final]))

    user_id = uuid4()
    thread_id = f"ask_vantage:{user_id}"
    tokens = dock_tools.set_dock_context(user_id=user_id, thread_id=thread_id, surface="dock")
    try:
        # Turn 1 parks on the interrupt.
        await _collect(
            dock_agent.run_dock_turn(
                message="tailor", thread_id=thread_id, graph_factory=lambda: graph
            )
        )
        # Turn 2 resumes — the same graph instance keeps the MemorySaver state.
        frames2 = await _collect(
            dock_agent.run_dock_turn(
                message="",
                thread_id=thread_id,
                command={"resume": "Stripe"},
                graph_factory=lambda: graph,
            )
        )
    finally:
        dock_tools.reset_dock_context(tokens)

    events2 = _parse_frames(frames2)
    # The resume turn runs to a normal (non-interrupt) completion.
    finished = [e for e in events2 if e.get("type") == "RUN_FINISHED"]
    assert finished, "resume turn never finished"
    assert finished[-1].get("outcome", {}).get("type") != "interrupt"


# ─────────────────────────────────────────────────────────── partial artifact


@pytest.mark.asyncio
async def test_emit_partial_artifact_outside_runner_is_noop():
    """Called outside a LangGraph callback context, it must not raise."""
    await dock_agent.emit_partial_artifact(artifact_id="x", kind="resume_bullet", progress=0.5)


# ───────────────────────────────────────────────────────────── unit: helpers


def test_decode_tool_content_dict_passthrough():
    assert dock_agent._decode_tool_content({"a": 1}) == {"a": 1}


def test_decode_tool_content_json_string():
    assert dock_agent._decode_tool_content('{"status": "ok"}') == {"status": "ok"}


def test_decode_tool_content_plain_string():
    assert dock_agent._decode_tool_content("Found 1 row") == "Found 1 row"


def test_decode_tool_content_malformed_json_falls_back_to_string():
    assert dock_agent._decode_tool_content("{not json") == "{not json"


def test_decode_tool_content_none():
    assert dock_agent._decode_tool_content(None) is None


def test_cap_for_wire_passes_small_value_through():
    small = {"matches": [{"id": "j1"}, {"id": "j2"}]}
    assert dock_agent._cap_for_wire(small) == small


def test_cap_for_wire_truncates_oversize_value():
    huge = {"items": ["x" * 100 for _ in range(500)]}
    capped = dock_agent._cap_for_wire(huge)
    assert isinstance(capped, str)
    assert capped.endswith("…[truncated]")
    assert len(capped.encode("utf-8")) <= dock_agent._TOOL_RESULT_CAP_BYTES + 32


def test_interrupt_reason_uses_kind():
    assert dock_agent._interrupt_reason({"kind": "clarification"}) == "clarification"


def test_interrupt_reason_infers_diff():
    assert dock_agent._interrupt_reason({"before": "a", "after": "b"}) == "diff"


def test_interrupt_reason_infers_ask_user():
    assert dock_agent._interrupt_reason({"question": "?"}) == "ask_user"


def test_interrupt_reason_infers_approval():
    assert dock_agent._interrupt_reason({"action": "submit"}) == "approval"
    assert dock_agent._interrupt_reason("not a dict") == "approval"


def test_interrupt_message_picks_message_question_summary():
    assert dock_agent._interrupt_message({"message": "m"}) == "m"
    assert dock_agent._interrupt_message({"question": "q"}) == "q"
    assert dock_agent._interrupt_message({"summary": "s"}) == "s"
    assert dock_agent._interrupt_message({}) is None


def test_custom_for_tool_result_propose_plan():
    em = RelayEmitter(run_id="r", thread_id="t", trace_id="x")
    frames = dock_agent._custom_for_tool_result(em, "propose_plan", {"plan": [], "plan_id": "p1"})
    assert len(frames) == 1
    obj = json.loads(frames[0][len("data: ") : -2])
    assert obj["name"] == "relay.task_graph"


def test_custom_for_tool_result_narrate_empty_dropped():
    em = RelayEmitter(run_id="r", thread_id="t", trace_id="x")
    assert dock_agent._custom_for_tool_result(em, "narrate", {"narration": "   "}) == []


def test_custom_for_tool_result_execution_tool_emits_done_and_artifact():
    em = RelayEmitter(run_id="r", thread_id="t", trace_id="x")
    frames = dock_agent._custom_for_tool_result(
        em, "find_jobs", {"status": "ok", "items": [], "count": 0}
    )
    names = [json.loads(f[len("data: ") : -2])["name"] for f in frames]
    assert names == ["relay.agent_done", "relay.artifact"]


def test_custom_for_tool_result_system_tool_silent():
    em = RelayEmitter(run_id="r", thread_id="t", trace_id="x")
    assert dock_agent._custom_for_tool_result(em, "recall_user_memory", {"status": "ok"}) == []


def test_build_dock_graph_invalid_tier():
    with pytest.raises(ValueError, match="invalid dock tier"):
        dock_agent.build_dock_graph(tier="ultra")


def test_build_dock_graph_caches(monkeypatch):
    sentinel = _ScriptedChat(responses=[AIMessage(content="ok")])
    with patch("agents.coordinator.dock_agent.pick_model", return_value=sentinel):
        dock_agent.build_dock_graph.cache_clear()
        a = dock_agent.build_dock_graph(tier="general")
        b = dock_agent.build_dock_graph(tier="general")
    assert a is b
