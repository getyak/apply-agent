"""LangGraph node + integration tests for the Dock ReAct agent.

We stub the LLM with ``FakeMessagesListChatModel`` so we can script tool-use
sequences without hitting OpenRouter. Each test verifies one slice of the
contract:
  - dock graph compiles with MemorySaver + propose_plan + execution tools
  - ``run_dock_turn`` yields a ``plan`` event when the model calls
    ``propose_plan``
  - tool errors translate to a ``tool_error`` event
  - DockEvent ``done`` fires when the chain completes
  - ``_translate_event`` is total over the relevant LangGraph event types
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import create_react_agent

from agents.coordinator import dock_agent, dock_tools


class _ScriptedChat(FakeMessagesListChatModel):
    """Subclass to bypass pydantic frozen-field restriction on bind_tools."""

    def bind_tools(self, *_a, **_kw):  # noqa: D401 — overrides ABC stub
        return self


def _scripted_chat(responses: list[AIMessage]) -> _ScriptedChat:
    """Return a chat fake that accepts bind_tools (no-op) and replays messages."""
    return _ScriptedChat(responses=responses)


def _build_test_graph(model: FakeMessagesListChatModel):
    """Compile a dock-style graph with a MemorySaver and the real DOCK_TOOLS."""
    return create_react_agent(
        model=model,
        tools=dock_tools.DOCK_TOOLS,
        prompt="You are Vantage. Plan first, then execute.",
        checkpointer=MemorySaver(),
    )


def test_translate_event_plan_from_tool_end():
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_end",
            "name": "propose_plan",
            "data": {"output": {"status": "ok", "plan": [], "plan_id": "p-1"}},
        }
    )
    assert evt is not None
    assert evt.kind == "plan"
    assert evt.payload["plan"]["plan_id"] == "p-1"


def test_translate_event_generic_tool_end():
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_end",
            "name": "list_my_applications",
            "data": {"output": {"status": "ok", "items": []}},
        }
    )
    assert evt is not None
    assert evt.kind == "tool_end"
    assert evt.payload["tool"] == "list_my_applications"


def test_translate_event_tool_start():
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_start",
            "name": "tailor_resume",
            "data": {"input": {"job_id": "x"}},
        }
    )
    assert evt is not None
    assert evt.kind == "tool_start"
    assert evt.payload["tool"] == "tailor_resume"
    assert evt.payload["args"]["job_id"] == "x"


def test_translate_event_tool_start_skips_narrate():
    """Step 1 — narrate's on_tool_start MUST be silent (no spinner row)."""
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_start",
            "name": "narrate",
            "data": {"input": {"thought": "Looking up your last Stripe app."}},
        }
    )
    assert evt is None


def test_translate_event_narrator_from_tool_end():
    """narrate() tool's on_tool_end → DockEvent(kind='narrator')."""
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_end",
            "name": "narrate",
            "data": {
                "output": {
                    "status": "ok",
                    "narration": "Sweeping the master résumé for payments wins.",
                }
            },
        }
    )
    assert evt is not None
    assert evt.kind == "narrator"
    assert evt.payload["text"] == "Sweeping the master résumé for payments wins."


def test_translate_event_empty_narrator_dropped():
    """A narrate() call that returns an empty string MUST be filtered."""
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_end",
            "name": "narrate",
            "data": {"output": {"status": "ok", "narration": ""}},
        }
    )
    assert evt is None


def test_translate_event_narrator_strips_whitespace():
    """Whitespace-only narration must drop to None, not produce an empty chip."""
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_end",
            "name": "narrate",
            "data": {"output": {"status": "ok", "narration": "   \t\n  "}},
        }
    )
    assert evt is None


def test_translate_event_partial_artifact_from_custom_event():
    """Step 5 — on_custom_event named partial_artifact → DockEvent."""
    evt = dock_agent._translate_event(
        {
            "event": "on_custom_event",
            "name": "partial_artifact",
            "data": {
                "artifact_id": "tailor-1",
                "kind": "resume_bullet",
                "title": "Tailored résumé v7 draft",
                "sub": "Bullet 2 of 5",
                "progress": 0.4,
                "payload": {"items": ["Bullet 1", "Bullet 2"]},
            },
        }
    )
    assert evt is not None
    assert evt.kind == "partial_artifact"
    assert evt.payload["artifact_id"] == "tailor-1"
    assert evt.payload["progress"] == 0.4
    assert evt.payload["payload"]["items"] == ["Bullet 1", "Bullet 2"]


def test_translate_event_partial_artifact_empty_dropped():
    evt = dock_agent._translate_event(
        {"event": "on_custom_event", "name": "partial_artifact", "data": {}}
    )
    assert evt is None


def test_translate_event_unknown_custom_event_dropped():
    """Only the named 'partial_artifact' channel surfaces — others ignored."""
    evt = dock_agent._translate_event(
        {
            "event": "on_custom_event",
            "name": "some_other_channel",
            "data": {"x": 1},
        }
    )
    assert evt is None


@pytest.mark.asyncio
async def test_emit_partial_artifact_outside_runner_is_noop():
    """Called outside a LangGraph callback context, it must not raise."""
    # Should silently no-op (the helper catches RuntimeError from
    # adispatch_custom_event when there's no run_manager).
    await dock_agent.emit_partial_artifact(artifact_id="x", kind="resume_bullet", progress=0.5)


def test_translate_event_tool_error():
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_error",
            "name": "find_jobs",
            "data": {"error": ValueError("boom")},
        }
    )
    assert evt is not None
    assert evt.kind == "tool_error"
    assert "boom" in evt.payload["error"]


def test_translate_event_chat_stream_text():
    class _Chunk:
        content = "hello"

    evt = dock_agent._translate_event(
        {"event": "on_chat_model_stream", "data": {"chunk": _Chunk()}}
    )
    assert evt is not None
    assert evt.kind == "assistant_delta"
    assert evt.payload["text"] == "hello"


def test_translate_event_chat_stream_list_content():
    class _Chunk:
        content = [{"text": "abc"}, {"text": "def"}, "tail"]

    evt = dock_agent._translate_event(
        {"event": "on_chat_model_stream", "data": {"chunk": _Chunk()}}
    )
    assert evt is not None
    assert evt.kind == "assistant_delta"
    assert evt.payload["text"] == "abcdeftail"


def test_translate_event_interrupt():
    evt = dock_agent._translate_event(
        {
            "event": "on_chain_stream",
            "data": {"chunk": {"__interrupt__": {"action": "approve"}}},
        }
    )
    assert evt is not None
    assert evt.kind == "interrupt"
    assert evt.payload["value"]["action"] == "approve"


def test_translate_event_done():
    evt = dock_agent._translate_event({"event": "on_chain_end", "name": "LangGraph"})
    assert evt is not None
    assert evt.kind == "done"


def test_translate_event_unknown_returns_none():
    assert dock_agent._translate_event({"event": "on_retriever_start"}) is None
    assert dock_agent._translate_event({}) is None


# ─── Inline-detail upgrade tests ─────────────────────────────────────
# Reasoning passthrough + same-chunk text/reasoning + result truncation.


def test_extract_reasoning_from_additional_kwargs():
    """OpenRouter primary path: chunk.additional_kwargs['reasoning']."""

    class _Chunk:
        content = ""
        additional_kwargs = {"reasoning": "Let me think about this…"}

    assert dock_agent._extract_reasoning(_Chunk()) == "Let me think about this…"


def test_extract_reasoning_from_reasoning_content_fallback():
    """Some providers use the legacy `reasoning_content` key."""

    class _Chunk:
        content = ""
        additional_kwargs = {"reasoning_content": "fallback thought"}

    assert dock_agent._extract_reasoning(_Chunk()) == "fallback thought"


def test_extract_reasoning_from_content_block():
    """Anthropic-style content list with a type: reasoning block."""

    class _Chunk:
        additional_kwargs = {}
        content = [
            {"type": "reasoning", "text": "block-a"},
            {"type": "text", "text": "actual answer"},
            {"type": "reasoning", "text": "block-b"},
        ]

    assert dock_agent._extract_reasoning(_Chunk()) == "block-ablock-b"


def test_extract_reasoning_returns_empty_when_absent():
    """No reasoning anywhere → empty string (caller drops the event)."""

    class _Chunk:
        content = "just text"
        additional_kwargs = {}

    assert dock_agent._extract_reasoning(_Chunk()) == ""


def test_extract_text_skips_reasoning_blocks():
    """Content-list reasoning blocks must NOT leak into the user-visible text."""

    class _Chunk:
        content = [
            {"type": "reasoning", "text": "secret thought"},
            {"type": "text", "text": "hello"},
        ]
        additional_kwargs = {}

    assert dock_agent._extract_text(_Chunk()) == "hello"


def test_translate_event_multi_emits_reasoning_delta_only():
    """A chunk with only reasoning → one reasoning_delta DockEvent."""

    class _Chunk:
        content = ""
        additional_kwargs = {"reasoning": "thinking out loud"}

    out = dock_agent._translate_event_multi(
        {"event": "on_chat_model_stream", "data": {"chunk": _Chunk()}}
    )
    assert len(out) == 1
    assert out[0].kind == "reasoning_delta"
    assert out[0].payload == {"text": "thinking out loud"}


def test_translate_event_multi_emits_both_text_and_reasoning():
    """Same chunk carries both lanes — emit reasoning first, then text."""

    class _Chunk:
        content = "the answer is X"
        additional_kwargs = {"reasoning": "I considered Y and Z"}

    out = dock_agent._translate_event_multi(
        {"event": "on_chat_model_stream", "data": {"chunk": _Chunk()}}
    )
    assert [(e.kind, e.payload["text"]) for e in out] == [
        ("reasoning_delta", "I considered Y and Z"),
        ("assistant_delta", "the answer is X"),
    ]


def test_translate_event_multi_passes_through_non_chat_events():
    """on_tool_start still flows through the single-event translator."""

    out = dock_agent._translate_event_multi(
        {
            "event": "on_tool_start",
            "name": "find_jobs",
            "data": {"input": {"query": "react"}},
        }
    )
    assert len(out) == 1
    assert out[0].kind == "tool_start"
    assert out[0].payload == {"tool": "find_jobs", "args": {"query": "react"}}


def test_cap_for_wire_passes_small_value_through():
    """Small results round-trip unchanged so JsonBlock pretty-prints them."""

    small = {"matches": [{"id": "j1"}, {"id": "j2"}]}
    assert dock_agent._cap_for_wire(small) == small


def test_cap_for_wire_truncates_oversize_value():
    """Anything bigger than the 8 KiB cap is stringified + suffixed."""

    huge = {"items": ["x" * 100 for _ in range(500)]}
    capped = dock_agent._cap_for_wire(huge)
    assert isinstance(capped, str)
    assert capped.endswith("…[truncated]")
    assert len(capped.encode("utf-8")) <= dock_agent._TOOL_RESULT_CAP_BYTES + 32


def test_tool_end_payload_carries_capped_result():
    """on_tool_end branch runs results through _cap_for_wire."""

    big = {"rows": ["x" * 50 for _ in range(500)]}
    evt = dock_agent._translate_event(
        {
            "event": "on_tool_end",
            "name": "find_jobs",
            "data": {"output": big},
        }
    )
    assert evt is not None
    assert evt.kind == "tool_end"
    assert isinstance(evt.payload["result"], str)
    assert evt.payload["result"].endswith("…[truncated]")


def test_build_dock_graph_invalid_tier():
    with pytest.raises(ValueError, match="invalid dock tier"):
        dock_agent.build_dock_graph(tier="ultra")


def test_build_dock_graph_caches(monkeypatch):
    """Two calls with the same tier should hit the lru_cache.

    We patch pick_model so we don't actually construct an httpx client (CI
    environments may have SOCKS env vars set that break the real path).
    The point of the test is the lru_cache identity, not the model layer.
    """
    sentinel = _ScriptedChat(responses=[AIMessage(content="ok")])
    with patch("agents.coordinator.dock_agent.pick_model", return_value=sentinel):
        dock_agent.build_dock_graph.cache_clear()
        a = dock_agent.build_dock_graph(tier="general")
        b = dock_agent.build_dock_graph(tier="general")
    assert a is b


@pytest.mark.asyncio
async def test_run_dock_turn_emits_plan_and_done(monkeypatch):
    """End-to-end: scripted LLM → graph yields plan + tool_end + done."""
    # Avoid monkeypatch.setenv on OPENROUTER_API_KEY — see test_ask_stream_dock_route.py.
    # The graph_factory= passes a pre-built fake graph, so the real env key never gets used.
    _ = monkeypatch  # keep the param signature

    plan_call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "propose_plan",
                "args": {
                    "user_goal": "List my pipeline",
                    "steps": [
                        {
                            "step": "list",
                            "agent": "applications",
                            "label": "List apps",
                        }
                    ],
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

    model = _scripted_chat([plan_call, exec_call, final])
    graph = _build_test_graph(model)

    user_id = uuid4()
    tokens = dock_tools.set_dock_context(
        user_id=user_id, thread_id=f"ask_vantage:{user_id}", surface="dock"
    )
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
            events = []
            async for evt in dock_agent.run_dock_turn(
                message="What's in my pipeline?",
                thread_id=f"ask_vantage:{user_id}",
                graph_factory=lambda: graph,
                recursion_limit=20,
            ):
                events.append(evt)
    finally:
        dock_tools.reset_dock_context(tokens)

    kinds = [e.kind for e in events]
    assert "plan" in kinds, f"expected plan event, got {kinds}"
    assert any(
        e.kind == "tool_end" and e.payload.get("tool") == "list_my_applications" for e in events
    ), f"missing list_my_applications tool_end in {kinds}"
    assert "done" in kinds


@pytest.mark.asyncio
async def test_run_dock_turn_propagates_recall_unavailable(monkeypatch):
    """When recall_user_memory degrades (PG unavailable), the tool_end event
    must carry ``status: "unavailable"`` so the dock can reason "no memory".

    This is the production-shaped failure: tools degrade by returning a
    structured envelope, not by raising. LangGraph's default ReAct
    behaviour treats raises as terminal, so we exercise the graceful path.
    """
    # Avoid monkeypatch.setenv on OPENROUTER_API_KEY — see test_ask_stream_dock_route.py.
    # The graph_factory= passes a pre-built fake graph, so the real env key never gets used.
    _ = monkeypatch  # keep the param signature

    plan = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "propose_plan",
                "args": {
                    "user_goal": "Recall preferences",
                    "steps": [
                        {
                            "step": "recall",
                            "agent": "coordinator",
                            "label": "recall memory",
                        }
                    ],
                },
                "id": "tc-1",
            }
        ],
    )
    recall_call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "recall_user_memory",
                "args": {"query": "preferences"},
                "id": "tc-2",
            }
        ],
    )
    final = AIMessage(content="No memory yet — happy to learn.")
    model = _scripted_chat([plan, recall_call, final])
    graph = _build_test_graph(model)

    user_id = uuid4()
    tokens = dock_tools.set_dock_context(
        user_id=user_id, thread_id=f"ask_vantage:{user_id}", surface="dock"
    )
    try:
        with patch(
            "agents.tools.auto.pg_query",
            new=AsyncMock(side_effect=RuntimeError("PG offline")),
        ):
            events = []
            async for evt in dock_agent.run_dock_turn(
                message="What do you remember about me?",
                thread_id=f"ask_vantage:{user_id}",
                graph_factory=lambda: graph,
                recursion_limit=20,
            ):
                events.append(evt)
    finally:
        dock_tools.reset_dock_context(tokens)

    recall_ends = [
        e for e in events if e.kind == "tool_end" and e.payload.get("tool") == "recall_user_memory"
    ]
    assert recall_ends, f"missing recall_user_memory tool_end in {[e.kind for e in events]}"
    payload = recall_ends[-1].payload["result"]
    # Decoded back to a dict by _decode_tool_output.
    assert isinstance(payload, dict), payload
    assert payload["status"] == "unavailable"
    assert payload["items"] == []
