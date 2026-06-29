"""AG-UI protocol contract test.

Guards against ag-ui-protocol / ag-ui-langgraph version churn (spec is still
0.x — see docs/architecture/agent-event-stream.md §2.2). Every frame the dock
emits MUST deserialize cleanly through the official ``ag_ui.core.Event``
discriminated union. If an upstream rename breaks a field, this test fails
*before* the web client ever sees a malformed frame.

Fixture: ``tests/fixtures/agui_events.jsonl`` — one captured AG-UI event per
line (the ``data:`` payload of a real ``dock_agent.run_dock_turn`` stream),
covering the standard lifecycle + every ``relay.*`` CUSTOM event. Regenerate
it with the dock agent when the event shape legitimately changes; a diff in
this fixture is a deliberate protocol change that needs review.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from ag_ui.core import Event, EventType
from pydantic import TypeAdapter

_FIXTURE = Path(__file__).parent.parent / "fixtures" / "agui_events.jsonl"
_EVENT_ADAPTER: TypeAdapter[Event] = TypeAdapter(Event)

# CUSTOM events Relay layers on top of the AG-UI standard set. All must use the
# ``relay.`` namespace (enforced by RelayEmitter.emit_custom) so they never
# collide with a future standard event name.
_EXPECTED_RELAY_CUSTOM = {
    "relay.task_graph",
    "relay.narrator",
    "relay.agent_start",
    "relay.agent_done",
    "relay.artifact",
    "relay.hitl_prep",
}


def _load_fixture() -> list[dict]:
    assert _FIXTURE.exists(), f"missing AG-UI fixture: {_FIXTURE}"
    rows: list[dict] = []
    for line in _FIXTURE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    assert rows, "fixture is empty"
    return rows


def test_every_fixture_event_deserializes_via_ag_ui_union():
    """Each captured frame round-trips through ag_ui.core.Event without error."""
    for i, raw in enumerate(_load_fixture()):
        try:
            event = _EVENT_ADAPTER.validate_python(raw)
        except Exception as exc:  # noqa: BLE001 — re-raise with context
            pytest.fail(f"fixture line {i} ({raw.get('type')}) failed to validate: {exc}\n{raw}")
        assert event.type == EventType(raw["type"])


def test_relay_custom_events_use_namespace():
    """Every CUSTOM event in the stream uses the ``relay.`` prefix."""
    customs = [r for r in _load_fixture() if r.get("type") == "CUSTOM"]
    assert customs, "fixture captured no CUSTOM events"
    for r in customs:
        name = r.get("name")
        assert isinstance(name, str) and name.startswith("relay."), r


def test_all_expected_relay_custom_names_present():
    """The fixture exercises the full set of Relay product CUSTOM events."""
    names = {r.get("name") for r in _load_fixture() if r.get("type") == "CUSTOM"}
    missing = _EXPECTED_RELAY_CUSTOM - names
    assert not missing, f"fixture missing relay CUSTOM events: {sorted(missing)}"


def test_lifecycle_and_tool_events_present():
    """Sanity: the captured stream covers the standard lifecycle + tool calls."""
    types = {r.get("type") for r in _load_fixture()}
    for required in ("RUN_STARTED", "RUN_FINISHED", "TOOL_CALL_START", "TOOL_CALL_RESULT"):
        assert required in types, f"fixture missing {required}"


def test_relay_envelope_present_on_relay_custom_events():
    """Relay CUSTOM events carry the envelope (seq / run_id / protocol_version)."""
    for r in _load_fixture():
        if r.get("type") == "CUSTOM" and str(r.get("name", "")).startswith("relay."):
            raw = r.get("rawEvent") or {}
            assert raw.get("run_id"), r
            assert raw.get("protocol_version"), r
            assert isinstance(raw.get("seq"), int), r
