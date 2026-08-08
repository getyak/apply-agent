"""Policy and state-machine tests for the durable agent recovery kernel."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from uuid import UUID, uuid4

import pytest

from agents.harness.recovery import (
    ActorType,
    EffectClass,
    ErrorClass,
    IdempotencyConflict,
    InMemoryOperationStore,
    OperationSpec,
    PostgresOperationStore,
    ReconcileOutcome,
    ReconcileResult,
    RecoveryError,
    RetryPolicy,
    canonical_json,
    classify_error,
    compute_backoff_ms,
    current_operation_id,
    execute_with_recovery,
    get_operation_store,
    operation_envelope,
    reconcile_existing_operation,
    set_operation_store_for_tests,
)


def _spec(
    *,
    key: str = "operation-key-0001",
    payload: dict | None = None,
    effect: EffectClass = EffectClass.READ,
) -> OperationSpec:
    return OperationSpec(
        user_id=uuid4(),
        operation_type="test.operation",
        idempotency_key=key,
        request_payload=payload or {"value": 1},
        effect_class=effect,
        actor_type=ActorType.CODEX,
    )


def test_canonical_json_sorts_objects_but_preserves_array_order():
    assert canonical_json({"b": 2, "a": {"d": 4, "c": 3}}) == canonical_json(
        {"a": {"c": 3, "d": 4}, "b": 2}
    )
    assert canonical_json({"items": [1, 2]}) != canonical_json({"items": [2, 1]})


def test_full_jitter_honors_retry_after_without_capping_it():
    policy = RetryPolicy(base_ms=500, cap_ms=8_000, max_attempts=3)
    assert compute_backoff_ms(policy, 2, random_fn=lambda: 0.5) == 500
    assert compute_backoff_ms(policy, 2, retry_after_ms=25_000, random_fn=lambda: 1.0) == 25_000


def test_classifier_distinguishes_auth_and_reads_retry_after_header():
    assert classify_error(PermissionError("denied")).error_class == ErrorClass.AUTH

    class Response:
        status_code = 429
        headers = {"Retry-After": "7"}

    class RateLimitError(Exception):
        response = Response()

    classified = classify_error(RateLimitError("slow down"))
    assert classified.error_class == ErrorClass.THROTTLED
    assert classified.retry_after_ms == 7_000


@pytest.mark.parametrize(
    ("status_code", "message", "expected_class"),
    [
        (402, "insufficient credits", ErrorClass.BUDGET),
        (403, "request blocked by guardrail", ErrorClass.POLICY),
        (412, "resource changed", ErrorClass.STALE_STATE),
        (500, "internal server error", ErrorClass.TRANSIENT),
        (529, "provider overloaded", ErrorClass.TRANSIENT),
    ],
)
def test_direct_openrouter_status_codes_use_documented_recovery_classes(
    status_code: int,
    message: str,
    expected_class: ErrorClass,
):
    class ProviderError(Exception):
        headers: dict[str, str] = {}

        def __init__(self):
            super().__init__(message)
            self.status_code = status_code

    assert classify_error(ProviderError()).error_class == expected_class


def test_direct_openrouter_retry_after_header_is_preserved_in_milliseconds():
    class RateLimitError(Exception):
        status_code = 429
        headers = {"Retry-After": "17.5"}

    error = classify_error(RateLimitError("slow down"))

    assert error.error_class == ErrorClass.THROTTLED
    assert error.retry_after_ms == 17_500


def test_retry_after_http_date_is_honored():
    class RateLimitError(Exception):
        status_code = 429
        headers = {
            "Retry-After": format_datetime(datetime.now(UTC) + timedelta(seconds=60), usegmt=True)
        }

    error = classify_error(RateLimitError("slow down"))

    assert error.error_class == ErrorClass.THROTTLED
    assert error.retry_after_ms is not None
    assert 55_000 <= error.retry_after_ms <= 60_000


def test_provider_and_database_connection_errors_are_retryable():
    OperationalError = type("OperationalError", (Exception,), {})
    NoResponseError = type("NoResponseError", (Exception,), {})

    assert classify_error(OperationalError("server closed")).error_class == ErrorClass.TRANSIENT
    assert classify_error(NoResponseError("no response")).error_class == ErrorClass.TRANSIENT


@pytest.mark.asyncio
async def test_pending_operation_instructs_callers_to_poll():
    store = InMemoryOperationStore()
    record, _ = await store.register(_spec())

    assert operation_envelope(record)["recovery"]["action"] == "poll"


def test_default_store_tracks_runtime_mode_changes(monkeypatch: pytest.MonkeyPatch):
    set_operation_store_for_tests(None)
    monkeypatch.delenv("RELAY_MCP_FAKE", raising=False)
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    assert isinstance(get_operation_store(), InMemoryOperationStore)

    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@example.test/relay")
    postgres_store = get_operation_store()
    assert isinstance(postgres_store, PostgresOperationStore)
    assert postgres_store.dsn == "postgresql://relay@example.test/relay"

    monkeypatch.setenv("RELAY_MCP_FAKE", "1")
    assert isinstance(get_operation_store(), InMemoryOperationStore)
    set_operation_store_for_tests(None)


@pytest.mark.asyncio
async def test_same_key_same_payload_executes_once_under_concurrency():
    store = InMemoryOperationStore()
    spec = _spec()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def execute():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return {"ok": True}

    first = asyncio.create_task(execute_with_recovery(spec, execute, store=store))
    await started.wait()
    duplicate = await execute_with_recovery(spec, execute, store=store)
    release.set()
    completed = await first

    assert calls == 1
    assert duplicate["status"] == "running"
    assert duplicate["recovery"]["action"] == "poll"
    assert completed["status"] == "succeeded"


@pytest.mark.asyncio
async def test_expired_lease_cannot_overwrite_a_newer_executor_result():
    store = InMemoryOperationStore()
    spec = _spec()
    first_started = asyncio.Event()
    second_started = asyncio.Event()
    release_first = asyncio.Event()
    release_second = asyncio.Event()
    calls = 0

    async def execute():
        nonlocal calls
        calls += 1
        if calls == 1:
            first_started.set()
            await release_first.wait()
            return {"executor": "stale"}
        second_started.set()
        await release_second.wait()
        return {"executor": "current"}

    zero_lease_spec = OperationSpec(**{**spec.__dict__, "lease_seconds": 0})
    first = asyncio.create_task(
        execute_with_recovery(
            zero_lease_spec,
            execute,
            store=store,
            executor_id="executor:first",
        )
    )
    await first_started.wait()
    second = asyncio.create_task(
        execute_with_recovery(
            zero_lease_spec,
            execute,
            store=store,
            executor_id="executor:second",
        )
    )
    await second_started.wait()
    release_second.set()
    current = await second
    release_first.set()
    stale = await first

    assert current["result"] == {"executor": "current"}
    assert stale["result"] == {"executor": "current"}
    assert current["recovery"]["attempt"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("effect", "expected_status", "expected_action"),
    [
        (EffectClass.READ, "cancelled", "stop"),
        (EffectClass.LOCAL_WRITE, "reconciling", "reconcile"),
    ],
)
async def test_cancellation_preserves_write_ambiguity(
    effect: EffectClass,
    expected_status: str,
    expected_action: str,
):
    store = InMemoryOperationStore()
    spec = _spec(effect=effect)
    started = asyncio.Event()

    async def execute():
        started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(execute_with_recovery(spec, execute, store=store))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    record, _ = await store.register(spec)
    envelope = operation_envelope(record)
    assert envelope["status"] == expected_status
    assert envelope["recovery"]["action"] == expected_action


@pytest.mark.asyncio
async def test_same_key_with_different_payload_is_rejected():
    store = InMemoryOperationStore()
    user_id = uuid4()
    common = {
        "user_id": user_id,
        "operation_type": "test.conflict",
        "idempotency_key": "same-key-different-request",
        "effect_class": EffectClass.READ,
    }
    first = OperationSpec(request_payload={"a": 1}, **common)
    second = OperationSpec(request_payload={"a": 2}, **common)

    await execute_with_recovery(first, lambda: asyncio.sleep(0, result={}), store=store)
    with pytest.raises(IdempotencyConflict):
        await execute_with_recovery(second, lambda: asyncio.sleep(0, result={}), store=store)


@pytest.mark.asyncio
async def test_transient_read_gets_retry_instruction_not_human_review():
    store = InMemoryOperationStore()

    async def fail():
        raise RecoveryError(
            "gateway warming",
            error_class=ErrorClass.TRANSIENT,
            code="UPSTREAM_UNAVAILABLE",
        )

    result = await execute_with_recovery(_spec(), fail, store=store, random_fn=lambda: 0.5)

    assert result["status"] == "waiting_retry"
    assert result["recovery"]["action"] == "retry"
    assert result["recovery"]["attempt"] == 1
    assert result["error"]["class"] == "transient"


@pytest.mark.asyncio
async def test_unknown_failure_is_not_retried():
    store = InMemoryOperationStore()

    async def fail():
        raise RuntimeError("unclassified provider failure")

    result = await execute_with_recovery(_spec(), fail, store=store)

    assert result["status"] == "waiting_user"
    assert result["recovery"]["action"] == "human_review"
    assert result["error"]["class"] == "unknown"


@pytest.mark.asyncio
async def test_ambiguous_write_reconciles_before_any_second_execution():
    store = InMemoryOperationStore()
    spec = _spec(effect=EffectClass.EXTERNAL_WRITE)
    executions = 0
    reconciliations = 0
    reconciled_operation_ids: list[UUID | None] = []

    async def execute():
        nonlocal executions
        executions += 1
        raise TimeoutError("connection dropped after request send")

    async def reconcile():
        nonlocal reconciliations
        reconciliations += 1
        reconciled_operation_ids.append(current_operation_id())
        return ReconcileResult(
            ReconcileOutcome.APPLIED,
            result={"provider_id": "msg_123"},
            observation={"provider_status": "accepted"},
        )

    uncertain = await execute_with_recovery(spec, execute, reconcile=reconcile, store=store)
    recovered = await execute_with_recovery(spec, execute, reconcile=reconcile, store=store)

    assert uncertain["status"] == "reconciling"
    assert uncertain["recovery"]["action"] == "reconcile"
    assert recovered["status"] == "succeeded"
    assert recovered["result"] == {"provider_id": "msg_123"}
    assert executions == 1
    assert reconciliations == 1
    assert reconciled_operation_ids == [UUID(uncertain["operation_id"])]
    assert current_operation_id() is None


@pytest.mark.asyncio
async def test_unknown_reconciliation_failure_stops_without_timed_retry():
    store = InMemoryOperationStore()
    spec = _spec(effect=EffectClass.LOCAL_WRITE)

    async def execute():
        raise TimeoutError("connection dropped after request send")

    async def reconcile():
        raise RuntimeError("unclassified reconciliation failure")

    await execute_with_recovery(spec, execute, reconcile=reconcile, store=store)
    result = await execute_with_recovery(spec, execute, reconcile=reconcile, store=store)

    assert result["status"] == "waiting_user"
    assert result["error"]["class"] == "unknown"
    assert result["recovery"]["not_before"] is None
    assert result["recovery"]["reconcile_attempt"] == 1


@pytest.mark.asyncio
async def test_waiting_user_cannot_be_reopened_by_reconcile_tool():
    store = InMemoryOperationStore()
    spec = _spec(effect=EffectClass.EXTERNAL_WRITE)
    reconciliations = 0

    async def execute():
        raise TimeoutError("browser click result unknown")

    async def inconclusive():
        return ReconcileResult(ReconcileOutcome.INCONCLUSIVE)

    uncertain = await execute_with_recovery(spec, execute, reconcile=inconclusive, store=store)
    waiting = uncertain
    for _ in range(3):
        waiting = await execute_with_recovery(
            spec,
            execute,
            reconcile=inconclusive,
            store=store,
            random_fn=lambda: 0,
        )

    async def should_not_run(_record):
        nonlocal reconciliations
        reconciliations += 1
        return ReconcileResult(ReconcileOutcome.APPLIED)

    result = await reconcile_existing_operation(
        operation_id=UUID(uncertain["operation_id"]),
        user_id=spec.user_id,
        reconcile=should_not_run,
        store=store,
    )

    assert waiting["status"] == "waiting_user"
    assert result is not None
    assert result["status"] == "waiting_user"
    assert reconciliations == 0


@pytest.mark.asyncio
async def test_external_write_not_applied_still_requires_human_review():
    store = InMemoryOperationStore()
    spec = _spec(effect=EffectClass.EXTERNAL_WRITE)
    executions = 0

    async def execute():
        nonlocal executions
        executions += 1
        raise TimeoutError("browser click result unknown")

    async def reconcile():
        return ReconcileResult(
            ReconcileOutcome.NOT_APPLIED,
            observation={"success_marker_visible": False},
        )

    await execute_with_recovery(spec, execute, reconcile=reconcile, store=store)
    result = await execute_with_recovery(spec, execute, reconcile=reconcile, store=store)

    assert result["status"] == "waiting_user"
    assert result["recovery"]["action"] == "human_review"
    assert executions == 1


@pytest.mark.asyncio
async def test_explicit_reconcile_entry_point_never_replays_original_effect():
    store = InMemoryOperationStore()
    spec = _spec(effect=EffectClass.EXTERNAL_WRITE)
    executions = 0

    async def execute():
        nonlocal executions
        executions += 1
        raise TimeoutError("result unknown")

    uncertain = await execute_with_recovery(spec, execute, store=store)
    reconciled = await reconcile_existing_operation(
        UUID(uncertain["operation_id"]),
        spec.user_id,
        lambda _record: asyncio.sleep(
            0,
            result=ReconcileResult(
                ReconcileOutcome.APPLIED,
                result={"confirmed": True},
            ),
        ),
        store=store,
    )

    assert reconciled is not None
    assert reconciled["status"] == "succeeded"
    assert reconciled["result"] == {"confirmed": True}
    assert executions == 1


@pytest.mark.asyncio
async def test_explicit_inconclusive_reconciliation_uses_its_bounded_budget():
    store = InMemoryOperationStore()
    spec = _spec(effect=EffectClass.EXTERNAL_WRITE)
    executions = 0
    probes = 0

    async def execute():
        nonlocal executions
        executions += 1
        raise TimeoutError("result unknown")

    async def reconcile(_record):
        nonlocal probes
        probes += 1
        return ReconcileResult(ReconcileOutcome.INCONCLUSIVE)

    state = await execute_with_recovery(spec, execute, store=store)
    operation_id = UUID(state["operation_id"])
    for expected_attempt in (1, 2):
        state = await reconcile_existing_operation(
            operation_id,
            spec.user_id,
            reconcile,
            store=store,
            random_fn=lambda: 0,
        )
        assert state is not None
        assert state["status"] == "reconciling"
        assert state["recovery"]["reconcile_attempt"] == expected_attempt

    state = await reconcile_existing_operation(
        operation_id,
        spec.user_id,
        reconcile,
        store=store,
        random_fn=lambda: 0,
    )
    assert state is not None
    assert state["status"] == "waiting_user"
    assert state["recovery"]["reconcile_attempt"] == 3
    assert executions == 1
    assert probes == 3
