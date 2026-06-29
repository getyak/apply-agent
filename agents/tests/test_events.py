"""Unit tests for agents.harness.events.RelayEmitter.

PR1 acceptance: ULID monotonic, seq monotonic, CUSTOM name namespace, SSE frame format,
raw_event envelope shape, all helper emitters round-trip via the SDK encoder.
"""

from __future__ import annotations

import json

import pytest

from agents.harness.events import RELAY_PROTOCOL_VERSION, RelayEmitter


def _parse_frame(frame: str) -> dict:
    """Strip the SSE 'data: ' prefix and trailing '\\n\\n', return the decoded JSON."""
    assert frame.startswith("data: ")
    assert frame.endswith("\n\n")
    payload = frame[len("data: ") : -2]
    return json.loads(payload)


def _make_emitter() -> RelayEmitter:
    return RelayEmitter(run_id="run-1", thread_id="ask_vantage:user-1", trace_id="trace-1")


# ---------------------------------------------------------------- envelope shape


def test_envelope_required_fields_present_in_raw_event() -> None:
    em = _make_emitter()
    frame = em.emit_run_started()
    obj = _parse_frame(frame)

    # SDK serializes raw_event as rawEvent (camelCase via Pydantic by_alias)
    raw = obj["rawEvent"]
    assert raw["id"]  # ULID
    assert raw["seq"] == 1
    assert raw["trace_id"] == "trace-1"
    assert raw["run_id"] == "run-1"
    assert raw["thread_id"] == "ask_vantage:user-1"
    assert raw["protocol_version"] == RELAY_PROTOCOL_VERSION


def test_envelope_optional_fields_when_passed() -> None:
    em = _make_emitter()
    frame = em.emit_custom("relay.task_graph", {"x": 1}, step_id="s1", parent_step_id="run-1")
    raw = _parse_frame(frame)["rawEvent"]
    assert raw["step_id"] == "s1"
    assert raw["parent_step_id"] == "run-1"


def test_envelope_extra_fields_overlay() -> None:
    em = _make_emitter()
    frame = em.emit_custom(
        "relay.agent_start",
        {"agent": "scout"},
        step_id="s2",
        extra={"plan_step": 3, "agent": "scout"},
    )
    raw = _parse_frame(frame)["rawEvent"]
    assert raw["plan_step"] == 3
    assert raw["agent"] == "scout"


# ---------------------------------------------------------------- monotonicity


def test_seq_increments_monotonically_across_helpers() -> None:
    em = _make_emitter()
    frames = [
        em.emit_run_started(),
        em.emit_custom("relay.narrator", {"text": "hi"}),
        em.emit_custom("relay.task_graph", {"plan": []}),
        em.emit_run_finished_success(result={"ok": True}),
    ]
    seqs = [_parse_frame(f)["rawEvent"]["seq"] for f in frames]
    assert seqs == [1, 2, 3, 4]
    assert em.seq == 4


def test_ulid_unique_per_event() -> None:
    em = _make_emitter()
    ids = [_parse_frame(em.emit_run_started())["rawEvent"]["id"] for _ in range(5)]
    assert len(set(ids)) == 5


def test_ulid_lexicographically_sortable() -> None:
    """ULID is time-ordered — later IDs sort >= earlier IDs (equal allowed within same ms)."""
    em = _make_emitter()
    ids = [_parse_frame(em.emit_run_started())["rawEvent"]["id"] for _ in range(10)]
    assert ids == sorted(ids)


# ---------------------------------------------------------------- CUSTOM namespace


def test_custom_name_must_start_with_relay_prefix() -> None:
    em = _make_emitter()
    with pytest.raises(ValueError, match="must start with 'relay.'"):
        em.emit_custom("task_graph", {"x": 1})


def test_custom_name_accepts_valid_relay_prefixes() -> None:
    em = _make_emitter()
    # all known prod CUSTOM names from agent-event-stream.md §3.3 + PR2/PR4 additions
    for name in [
        "relay.task_graph",
        "relay.task_graph_step",
        "relay.artifact",
        "relay.partial_artifact",
        "relay.narrator",
        "relay.agents_group",
        "relay.agent_start",
        "relay.agent_done",
        "relay.hitl_prep",
        "relay.file_edit",
        "relay.file_edit.preview",
        "relay.browser_snapshot",
        "relay.browser_action",
    ]:
        frame = em.emit_custom(name, {"x": 1})
        obj = _parse_frame(frame)
        assert obj["name"] == name
        assert obj["type"] == "CUSTOM"


def test_custom_value_round_trips() -> None:
    em = _make_emitter()
    payload = {
        "plan": [{"step": 1, "title": "Find roles"}],
        "deep": {"nested": [1, 2, {"x": True}]},
    }
    frame = em.emit_custom("relay.task_graph", payload, step_id="s1")
    obj = _parse_frame(frame)
    assert obj["value"] == payload


# ---------------------------------------------------------------- SSE frame format


def test_frame_is_str_with_data_prefix_and_double_newline() -> None:
    em = _make_emitter()
    frame = em.emit_run_started()
    assert isinstance(frame, str)
    assert frame.startswith("data: ")
    assert frame.endswith("\n\n")
    # exactly one data line; caller may concat event:/id: lines externally
    lines = [line for line in frame.split("\n") if line]
    assert len(lines) == 1


def test_timestamp_set_on_every_event_milliseconds() -> None:
    em = _make_emitter()
    obj = _parse_frame(em.emit_run_started())
    ts = obj["timestamp"]
    # 1e12 < ms < 1e14 covers 2001..5138 — sanity check
    assert 1_000_000_000_000 < ts < 100_000_000_000_000


# ---------------------------------------------------------------- helper emitters


def test_run_started_carries_thread_run_input() -> None:
    em = _make_emitter()
    obj = _parse_frame(em.emit_run_started())
    assert obj["type"] == "RUN_STARTED"
    assert obj["threadId"] == "ask_vantage:user-1"
    assert obj["runId"] == "run-1"


def test_run_finished_success_has_outcome_success() -> None:
    em = _make_emitter()
    obj = _parse_frame(em.emit_run_finished_success(result={"ok": True}))
    assert obj["type"] == "RUN_FINISHED"
    assert obj["outcome"] == {"type": "success"}
    assert obj["result"] == {"ok": True}


def test_run_finished_interrupt_requires_nonempty_list() -> None:
    em = _make_emitter()
    with pytest.raises(ValueError, match="at least one interrupt"):
        em.emit_run_finished_interrupt([])


def test_run_finished_interrupt_serializes_outcome_payload() -> None:
    em = _make_emitter()
    # Interrupt requires {id, reason}; optional message/tool_call_id/response_schema/...
    # See agents/.venv/.../ag_ui/core/types.py:Interrupt.
    interrupt_payloads = [
        {
            "id": "i-1",
            "reason": "approval",  # caller-defined free string, e.g. "approval" / "ask_user" / "diff"
            "message": "Approve submit_form?",
            "metadata": {"action": "submit_form", "url": "https://example.com/apply"},
        }
    ]
    obj = _parse_frame(em.emit_run_finished_interrupt(interrupt_payloads))
    assert obj["type"] == "RUN_FINISHED"
    assert obj["outcome"]["type"] == "interrupt"
    assert len(obj["outcome"]["interrupts"]) == 1
    assert obj["outcome"]["interrupts"][0]["id"] == "i-1"
    assert obj["outcome"]["interrupts"][0]["reason"] == "approval"


def test_run_error_carries_code_and_message() -> None:
    em = _make_emitter()
    obj = _parse_frame(em.emit_run_error(message="boom", code="LLM_BUDGET_EXHAUSTED"))
    assert obj["type"] == "RUN_ERROR"
    assert obj["message"] == "boom"
    assert obj["code"] == "LLM_BUDGET_EXHAUSTED"


# ---------------------------------------------------------------- multi-emitter isolation


def test_emitters_are_independent() -> None:
    """Each dock turn gets a fresh emitter — seq should not bleed across runs."""
    em1 = RelayEmitter(run_id="r1", thread_id="t1", trace_id="trc-1")
    em2 = RelayEmitter(run_id="r2", thread_id="t2", trace_id="trc-2")
    em1.emit_run_started()
    em1.emit_run_started()
    em2.emit_run_started()

    assert em1.seq == 2
    assert em2.seq == 1
