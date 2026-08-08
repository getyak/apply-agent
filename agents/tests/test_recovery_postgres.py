"""Live PostgreSQL contract for the durable operation ledger."""

from __future__ import annotations

import os
from uuid import uuid4

import psycopg
import pytest

from agents.harness.recovery import (
    ActorType,
    AttemptOutcome,
    EffectClass,
    IdempotencyConflict,
    OperationSpec,
    OperationStatus,
    PostgresOperationStore,
)

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_postgres_store_enforces_idempotency_ownership_and_lease_fencing():
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        pytest.skip("RELAY_PG_DSN is required for the operation-ledger contract")
    dsn = dsn.replace("@localhost:", "@127.0.0.1:")

    user_id = uuid4()
    other_user_id = uuid4()
    email = f"recovery-{user_id}@example.test"
    store = PostgresOperationStore(dsn)
    spec = OperationSpec(
        user_id=user_id,
        operation_type="test.postgres_operation",
        idempotency_key="postgres-contract-key-0001",
        request_payload={"application_id": str(uuid4()), "status": "review"},
        request_summary={"status": "review"},
        effect_class=EffectClass.LOCAL_WRITE,
        actor_type=ActorType.CODEX,
    )

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO users (id, email, display_name) VALUES (%s, %s, %s)",
                (str(user_id), email, "Recovery Contract"),
            )

    try:
        record, created = await store.register(spec)
        replay, replay_created = await store.register(spec)
        assert created is True
        assert replay_created is False
        assert replay.id == record.id
        assert await store.get(record.id, other_user_id) is None

        conflicting = OperationSpec(
            user_id=user_id,
            operation_type=spec.operation_type,
            idempotency_key=spec.idempotency_key,
            request_payload={"application_id": str(uuid4()), "status": "submitted"},
            effect_class=spec.effect_class,
            actor_type=spec.actor_type,
        )
        with pytest.raises(IdempotencyConflict):
            await store.register(conflicting)

        first_claim = await store.claim(
            record.id,
            user_id,
            "executor:first",
            lease_seconds=0,
        )
        second_claim = await store.claim(
            record.id,
            user_id,
            "executor:second",
            lease_seconds=30,
        )
        assert first_claim.attempt_no == 1
        assert second_claim.attempt_no is not None
        assert second_claim.record.lease_owner == "executor:second"

        stale = await store.transition(
            record.id,
            user_id,
            status=OperationStatus.SUCCEEDED,
            result={"executor": "stale"},
            expected_lease_owner="executor:first",
        )
        assert stale.status == OperationStatus.RECONCILING
        assert stale.result is None

        await store.record_attempt(
            second_claim,
            executor_id="executor:second",
            outcome=AttemptOutcome.SUCCEEDED,
        )
        completed = await store.transition(
            record.id,
            user_id,
            status=OperationStatus.SUCCEEDED,
            result={"executor": "current"},
            expected_lease_owner="executor:second",
        )
        assert completed.result == {"executor": "current"}

        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT length(idempotency_key_digest), length(request_hash),
                           count(attempt.id)
                      FROM agent_operations operation
                      LEFT JOIN agent_operation_attempts attempt
                        ON attempt.operation_id = operation.id
                     WHERE operation.id = %s
                     GROUP BY operation.id
                    """,
                    (str(record.id),),
                )
                persisted = await cur.fetchone()
        assert persisted == (64, 64, 1)
    finally:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute("DELETE FROM users WHERE id = %s", (str(user_id),))
