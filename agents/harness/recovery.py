"""Durable idempotency, reconciliation, and classified retry for Relay agents.

The operation ledger is deliberately separate from ``agent_tasks``: the
former is mutable execution truth, while the latter remains append-only audit
and cost evidence.  PostgreSQL is authoritative; Redis may wake workers but is
never required for correctness.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import os
import random
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from enum import StrEnum
from typing import Any, Protocol
from uuid import UUID, uuid4


class ActorType(StrEnum):
    RELAY = "relay"
    CODEX = "codex"
    CLAUDE_CODE = "claude_code"
    MCP = "mcp"
    BROWSER_EXTENSION = "browser_extension"


class EffectClass(StrEnum):
    READ = "read"
    COMPUTE = "compute"
    LOCAL_WRITE = "local_write"
    EXTERNAL_WRITE = "external_write"


class OperationStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    RECONCILING = "reconciling"
    WAITING_RETRY = "waiting_retry"
    WAITING_USER = "waiting_user"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ErrorClass(StrEnum):
    TRANSIENT = "transient"
    THROTTLED = "throttled"
    AMBIGUOUS_EFFECT = "ambiguous_effect"
    CONFLICT = "conflict"
    STALE_STATE = "stale_state"
    AUTH = "auth"
    VALIDATION = "validation"
    POLICY = "policy"
    CAPTCHA = "captcha"
    USER_REJECTED = "user_rejected"
    BUDGET = "budget"
    CONTENT_REFUSED = "content_refused"
    FABRICATION_BLOCKED = "fabrication_blocked"
    CANCELLED = "cancelled"
    PERMANENT = "permanent"
    UNKNOWN = "unknown"


class AttemptPhase(StrEnum):
    EXECUTE = "execute"
    RECONCILE = "reconcile"


class AttemptOutcome(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNKNOWN = "unknown"


class ReconcileOutcome(StrEnum):
    APPLIED = "applied"
    NOT_APPLIED = "not_applied"
    INCONCLUSIVE = "inconclusive"


TERMINAL_STATUSES = frozenset(
    {OperationStatus.SUCCEEDED, OperationStatus.FAILED, OperationStatus.CANCELLED}
)
WRITE_EFFECTS = frozenset({EffectClass.LOCAL_WRITE, EffectClass.EXTERNAL_WRITE})


@dataclass(frozen=True)
class RetryPolicy:
    base_ms: int
    cap_ms: int
    max_attempts: int


RETRY_POLICIES: Mapping[ErrorClass, RetryPolicy] = {
    ErrorClass.TRANSIENT: RetryPolicy(base_ms=500, cap_ms=8_000, max_attempts=3),
    ErrorClass.THROTTLED: RetryPolicy(base_ms=2_000, cap_ms=60_000, max_attempts=3),
}
DB_RETRY_POLICY = RetryPolicy(base_ms=100, cap_ms=2_000, max_attempts=5)
RECONCILE_POLICY = RetryPolicy(base_ms=1_000, cap_ms=30_000, max_attempts=3)


@dataclass(frozen=True)
class ClassifiedError:
    error_class: ErrorClass
    code: str
    message: str
    retry_after_ms: int | None = None
    db_contention: bool = False


class RecoveryError(RuntimeError):
    """An explicitly classified boundary error raised by an adapter."""

    def __init__(
        self,
        message: str,
        *,
        error_class: ErrorClass,
        code: str,
        retry_after_ms: int | None = None,
        db_contention: bool = False,
    ) -> None:
        super().__init__(message)
        self.error_class = error_class
        self.code = code
        self.retry_after_ms = retry_after_ms
        self.db_contention = db_contention


class IdempotencyConflict(RuntimeError):
    """The same idempotency key was reused with a different request."""


@dataclass(frozen=True)
class OperationSpec:
    user_id: UUID
    operation_type: str
    idempotency_key: str
    request_payload: Mapping[str, Any]
    effect_class: EffectClass
    actor_type: ActorType = ActorType.RELAY
    request_summary: Mapping[str, Any] = field(default_factory=dict)
    resource_ref: Mapping[str, Any] = field(default_factory=dict)
    max_elapsed_seconds: float = 120.0
    lease_seconds: int = 30

    def __post_init__(self) -> None:
        if not self.operation_type.strip():
            raise ValueError("operation_type must be non-empty")
        if not 16 <= len(self.idempotency_key) <= 200:
            raise ValueError("idempotency_key must contain 16-200 characters")

    @property
    def idempotency_key_digest(self) -> str:
        return hashlib.sha256(self.idempotency_key.encode("utf-8")).hexdigest()

    @property
    def request_hash(self) -> str:
        return hashlib.sha256(canonical_json(self.request_payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class OperationRecord:
    id: UUID
    user_id: UUID
    operation_type: str
    actor_type: ActorType
    effect_class: EffectClass
    request_hash: str
    status: OperationStatus
    request_summary: Mapping[str, Any] = field(default_factory=dict)
    resource_ref: Mapping[str, Any] = field(default_factory=dict)
    result: Any = None
    error_class: ErrorClass | None = None
    error_code: str | None = None
    error_message: str | None = None
    attempt_count: int = 0
    reconcile_count: int = 0
    next_attempt_at: datetime | None = None
    lease_owner: str | None = None
    lease_expires_at: datetime | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None


@dataclass(frozen=True)
class OperationClaim:
    record: OperationRecord
    phase: AttemptPhase | None
    attempt_no: int | None
    started_at: datetime | None


@dataclass(frozen=True)
class ReconcileResult:
    outcome: ReconcileOutcome
    result: Any = None
    observation: Mapping[str, Any] = field(default_factory=dict)


class OperationStore(Protocol):
    async def register(self, spec: OperationSpec) -> tuple[OperationRecord, bool]: ...

    async def get(self, operation_id: UUID, user_id: UUID) -> OperationRecord | None: ...

    async def claim(
        self, operation_id: UUID, user_id: UUID, executor_id: str, *, lease_seconds: int
    ) -> OperationClaim: ...

    async def record_attempt(
        self,
        claim: OperationClaim,
        *,
        executor_id: str,
        outcome: AttemptOutcome,
        error: ClassifiedError | None = None,
        retry_delay_ms: int | None = None,
        trace_id: str | None = None,
        observation: Mapping[str, Any] | None = None,
    ) -> None: ...

    async def transition(
        self,
        operation_id: UUID,
        user_id: UUID,
        *,
        status: OperationStatus,
        result: Any = None,
        error: ClassifiedError | None = None,
        next_attempt_at: datetime | None = None,
        expected_lease_owner: str | None = None,
    ) -> OperationRecord: ...


def canonical_json(value: Any) -> str:
    """Stable JSON hash input: object keys sort, array order remains meaningful."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def compute_backoff_ms(
    policy: RetryPolicy,
    attempt: int,
    *,
    retry_after_ms: int | None = None,
    random_fn: Callable[[], float] = random.random,
) -> int:
    """Full-jitter exponential backoff, with an uncapped server Retry-After floor."""

    ceiling = min(policy.cap_ms, policy.base_ms * (2 ** max(0, attempt - 1)))
    jittered = int(max(0.0, min(1.0, random_fn())) * ceiling)
    return max(jittered, retry_after_ms or 0)


_SECRET_RE = re.compile(r"(?i)(?:sk-[A-Za-z0-9_-]+|(?:postgres(?:ql)?|redis)://\S+|bearer\s+\S+)")


def _safe_error_message(message: str) -> str:
    return _SECRET_RE.sub("<redacted>", message.replace("\n", " "))[:500]


def _retry_after_ms(exc: BaseException) -> int | None:
    explicit = getattr(exc, "retry_after_ms", None)
    if isinstance(explicit, int | float) and explicit >= 0:
        return int(explicit)
    response = getattr(exc, "response", None)
    headers = getattr(exc, "headers", None) or getattr(response, "headers", None)
    if headers is None or not hasattr(headers, "get"):
        return None
    raw = headers.get("Retry-After") or headers.get("retry-after")
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        try:
            retry_at = parsedate_to_datetime(str(raw))
        except (TypeError, ValueError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=UTC)
        return max(0, int((retry_at - datetime.now(UTC)).total_seconds() * 1000))
    return int(seconds * 1000) if seconds >= 0 else None


def classify_error(exc: BaseException) -> ClassifiedError:
    """Map boundary exceptions into recovery classes; unknown never means retry."""

    if isinstance(exc, RecoveryError):
        return ClassifiedError(
            exc.error_class,
            exc.code,
            _safe_error_message(str(exc)),
            retry_after_ms=exc.retry_after_ms,
            db_contention=exc.db_contention,
        )
    if isinstance(exc, asyncio.CancelledError):
        return ClassifiedError(ErrorClass.CANCELLED, "CANCELLED", "operation cancelled")

    name = type(exc).__name__
    message = _safe_error_message(str(exc))
    upper = f"{name} {message}".upper()
    code = str(getattr(exc, "code", "") or "")
    response = getattr(exc, "response", None)
    status = getattr(exc, "status_code", None) or getattr(response, "status_code", None)
    try:
        status = int(status) if status is not None else None
    except (TypeError, ValueError):
        status = None
    sqlstate = str(getattr(exc, "sqlstate", "") or "")

    if sqlstate in {"40001", "40P01"}:
        return ClassifiedError(
            ErrorClass.TRANSIENT,
            "DB_CONTENTION",
            message or name,
            db_contention=True,
        )
    if "CAPTCHA" in upper or "SECURITY CHECK" in upper:
        return ClassifiedError(ErrorClass.CAPTCHA, code or "CAPTCHA_REQUIRED", message or name)
    if "FABRICATION" in upper:
        return ClassifiedError(
            ErrorClass.FABRICATION_BLOCKED,
            code or "LLM_FABRICATION_BLOCKED",
            message or name,
        )
    if status == 402 or "QUOTA_EXCEEDED" in upper or "BUDGET EXHAUST" in upper:
        return ClassifiedError(ErrorClass.BUDGET, code or "BUDGET_EXHAUSTED", message or name)
    if any(
        marker in upper
        for marker in (
            "CONTENT_FILTER",
            "CONTENT POLICY",
            "CONTENT_POLICY",
            "MODERATION",
            "REFUSAL",
            "REFUSED",
        )
    ):
        return ClassifiedError(
            ErrorClass.CONTENT_REFUSED,
            code or "LLM_CONTENT_REFUSED",
            message or name,
        )
    if status == 403 and ("GUARDRAIL" in upper or "BLOCKED" in upper):
        return ClassifiedError(ErrorClass.POLICY, code or "POLICY_BLOCKED", message or name)
    if sqlstate.startswith("23") or status in {400, 404, 405, 413, 422}:
        return ClassifiedError(ErrorClass.VALIDATION, code or "VALIDATION_FAILED", message or name)
    if sqlstate.startswith("28") or status in {401, 403}:
        return ClassifiedError(ErrorClass.AUTH, code or "AUTH_REQUIRED", message or name)
    if status == 409:
        return ClassifiedError(ErrorClass.CONFLICT, code or "RESOURCE_CONFLICT", message or name)
    if status == 412:
        return ClassifiedError(ErrorClass.STALE_STATE, code or "STALE_STATE", message or name)
    if status == 429:
        return ClassifiedError(
            ErrorClass.THROTTLED,
            code or "RATE_LIMITED",
            message or name,
            retry_after_ms=_retry_after_ms(exc),
        )
    if status in {408, 500, 502, 503, 504, 524, 529}:
        return ClassifiedError(
            ErrorClass.TRANSIENT,
            code or "UPSTREAM_UNAVAILABLE",
            message or name,
            retry_after_ms=_retry_after_ms(exc),
        )
    if isinstance(exc, PermissionError):
        return ClassifiedError(ErrorClass.AUTH, code or "AUTH_FORBIDDEN", message or name)
    if isinstance(exc, TimeoutError | ConnectionError | OSError):
        return ClassifiedError(ErrorClass.TRANSIENT, code or name.upper(), message or name)
    if name in {
        "ConnectError",
        "ConnectTimeout",
        "InterfaceError",
        "NetworkError",
        "NoResponseError",
        "OperationalError",
        "PoolTimeout",
        "ReadError",
        "ReadTimeout",
        "RemoteProtocolError",
        "WriteError",
        "WriteTimeout",
    }:
        return ClassifiedError(ErrorClass.TRANSIENT, code or name.upper(), message or name)
    if isinstance(exc, ValueError | TypeError):
        return ClassifiedError(ErrorClass.VALIDATION, code or "VALIDATION_FAILED", message or name)
    return ClassifiedError(ErrorClass.UNKNOWN, code or name.upper(), message or name)


def _policy_for(error: ClassifiedError) -> RetryPolicy | None:
    if error.db_contention:
        return DB_RETRY_POLICY
    return RETRY_POLICIES.get(error.error_class)


def _recovery_action(record: OperationRecord) -> str:
    if record.status == OperationStatus.SUCCEEDED:
        return "none"
    if record.status == OperationStatus.RECONCILING:
        return "reconcile"
    if record.status == OperationStatus.WAITING_RETRY:
        return "retry"
    if record.status in {OperationStatus.PENDING, OperationStatus.RUNNING}:
        return "poll"
    if record.status == OperationStatus.WAITING_USER:
        if record.error_class == ErrorClass.AUTH:
            return "reauth"
        if record.error_class == ErrorClass.VALIDATION:
            return "fix_input"
        return "human_review"
    return "stop"


def operation_envelope(record: OperationRecord) -> dict[str, Any]:
    max_attempts = None
    if record.error_class is not None:
        policy = _policy_for(
            ClassifiedError(record.error_class, record.error_code or "", record.error_message or "")
        )
        if record.error_code == "DB_CONTENTION":
            max_attempts = DB_RETRY_POLICY.max_attempts
        else:
            max_attempts = policy.max_attempts if policy else None
    return {
        "operation_id": str(record.id),
        "status": record.status.value,
        "result": record.result,
        "error": (
            {
                "code": record.error_code,
                "class": record.error_class.value,
                "message": record.error_message,
            }
            if record.error_class
            else None
        ),
        "recovery": {
            "action": _recovery_action(record),
            "not_before": record.next_attempt_at.isoformat() if record.next_attempt_at else None,
            "attempt": record.attempt_count,
            "max_attempts": max_attempts,
            "reconcile_attempt": record.reconcile_count,
            "max_reconcile_attempts": RECONCILE_POLICY.max_attempts,
        },
    }


class InMemoryOperationStore:
    """Concurrency-correct test/local fallback with the same state semantics as PG."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._records: dict[UUID, OperationRecord] = {}
        self._keys: dict[tuple[UUID, str, str], UUID] = {}
        self.attempts: list[dict[str, Any]] = []

    async def register(self, spec: OperationSpec) -> tuple[OperationRecord, bool]:
        key = (spec.user_id, spec.operation_type, spec.idempotency_key_digest)
        async with self._lock:
            existing_id = self._keys.get(key)
            if existing_id is not None:
                existing = self._records[existing_id]
                if existing.request_hash != spec.request_hash:
                    raise IdempotencyConflict(
                        "Idempotency key reused with a different request payload"
                    )
                return existing, False
            now = datetime.now(UTC)
            record = OperationRecord(
                id=uuid4(),
                user_id=spec.user_id,
                operation_type=spec.operation_type,
                actor_type=spec.actor_type,
                effect_class=spec.effect_class,
                request_hash=spec.request_hash,
                status=OperationStatus.PENDING,
                request_summary=dict(spec.request_summary),
                resource_ref=dict(spec.resource_ref),
                created_at=now,
                updated_at=now,
            )
            self._records[record.id] = record
            self._keys[key] = record.id
            return record, True

    async def get(self, operation_id: UUID, user_id: UUID) -> OperationRecord | None:
        record = self._records.get(operation_id)
        return record if record and record.user_id == user_id else None

    async def claim(
        self, operation_id: UUID, user_id: UUID, executor_id: str, *, lease_seconds: int
    ) -> OperationClaim:
        async with self._lock:
            record = self._records[operation_id]
            if record.user_id != user_id:
                raise KeyError(operation_id)
            now = datetime.now(UTC)
            if record.status in TERMINAL_STATUSES or record.status == OperationStatus.WAITING_USER:
                return OperationClaim(record, None, None, None)
            if record.next_attempt_at and record.next_attempt_at > now:
                return OperationClaim(record, None, None, None)
            lease_live = record.lease_expires_at is not None and record.lease_expires_at > now
            if (
                record.status in {OperationStatus.RUNNING, OperationStatus.RECONCILING}
                and lease_live
            ):
                return OperationClaim(record, None, None, None)

            phase = AttemptPhase.EXECUTE
            if record.status == OperationStatus.RECONCILING or (
                record.status == OperationStatus.RUNNING
                and not lease_live
                and record.effect_class in WRITE_EFFECTS
            ):
                phase = AttemptPhase.RECONCILE
            attempt_count = record.attempt_count + (phase == AttemptPhase.EXECUTE)
            reconcile_count = record.reconcile_count + (phase == AttemptPhase.RECONCILE)
            claimed = replace(
                record,
                status=(
                    OperationStatus.RUNNING
                    if phase == AttemptPhase.EXECUTE
                    else OperationStatus.RECONCILING
                ),
                attempt_count=int(attempt_count),
                reconcile_count=int(reconcile_count),
                next_attempt_at=None,
                lease_owner=executor_id,
                lease_expires_at=now + timedelta(seconds=lease_seconds),
                updated_at=now,
            )
            self._records[operation_id] = claimed
            number = (
                claimed.attempt_count if phase == AttemptPhase.EXECUTE else claimed.reconcile_count
            )
            return OperationClaim(claimed, phase, number, now)

    async def record_attempt(
        self,
        claim: OperationClaim,
        *,
        executor_id: str,
        outcome: AttemptOutcome,
        error: ClassifiedError | None = None,
        retry_delay_ms: int | None = None,
        trace_id: str | None = None,
        observation: Mapping[str, Any] | None = None,
    ) -> None:
        self.attempts.append(
            {
                "operation_id": claim.record.id,
                "phase": claim.phase,
                "attempt_no": claim.attempt_no,
                "executor_id": executor_id,
                "outcome": outcome,
                "error": error,
                "retry_delay_ms": retry_delay_ms,
                "trace_id": trace_id,
                "observation": dict(observation or {}),
                "started_at": claim.started_at,
            }
        )

    async def transition(
        self,
        operation_id: UUID,
        user_id: UUID,
        *,
        status: OperationStatus,
        result: Any = None,
        error: ClassifiedError | None = None,
        next_attempt_at: datetime | None = None,
        expected_lease_owner: str | None = None,
    ) -> OperationRecord:
        async with self._lock:
            record = self._records[operation_id]
            if record.user_id != user_id:
                raise KeyError(operation_id)
            if expected_lease_owner is not None and record.lease_owner != expected_lease_owner:
                return record
            now = datetime.now(UTC)
            changed = replace(
                record,
                status=status,
                result=result,
                error_class=error.error_class if error else None,
                error_code=error.code if error else None,
                error_message=error.message if error else None,
                next_attempt_at=next_attempt_at,
                lease_owner=None,
                lease_expires_at=None,
                updated_at=now,
                completed_at=now if status in TERMINAL_STATUSES else None,
            )
            self._records[operation_id] = changed
            return changed


class PostgresOperationStore:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    async def _connect(self):
        import psycopg
        from psycopg.rows import dict_row

        return await psycopg.AsyncConnection.connect(self.dsn, row_factory=dict_row)

    @staticmethod
    def _record(row: Mapping[str, Any]) -> OperationRecord:
        return OperationRecord(
            id=UUID(str(row["id"])),
            user_id=UUID(str(row["user_id"])),
            operation_type=str(row["operation_type"]),
            actor_type=ActorType(row["actor_type"]),
            effect_class=EffectClass(row["effect_class"]),
            request_hash=str(row["request_hash"]),
            status=OperationStatus(row["status"]),
            request_summary=row.get("request_summary") or {},
            resource_ref=row.get("resource_ref") or {},
            result=row.get("result"),
            error_class=ErrorClass(row["error_class"]) if row.get("error_class") else None,
            error_code=row.get("error_code"),
            error_message=row.get("error_message"),
            attempt_count=int(row.get("attempt_count") or 0),
            reconcile_count=int(row.get("reconcile_count") or 0),
            next_attempt_at=row.get("next_attempt_at"),
            lease_owner=row.get("lease_owner"),
            lease_expires_at=row.get("lease_expires_at"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            completed_at=row.get("completed_at"),
        )

    async def register(self, spec: OperationSpec) -> tuple[OperationRecord, bool]:
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO agent_operations (
                        user_id, operation_type, actor_type, effect_class,
                        idempotency_key_digest, request_hash, request_summary, resource_ref
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb)
                    ON CONFLICT (user_id, operation_type, idempotency_key_digest) DO NOTHING
                    RETURNING *
                    """,
                    (
                        str(spec.user_id),
                        spec.operation_type,
                        spec.actor_type.value,
                        spec.effect_class.value,
                        spec.idempotency_key_digest,
                        spec.request_hash,
                        canonical_json(spec.request_summary),
                        canonical_json(spec.resource_ref),
                    ),
                )
                row = await cur.fetchone()
                created = row is not None
                if row is None:
                    await cur.execute(
                        """
                        SELECT * FROM agent_operations
                         WHERE user_id = %s AND operation_type = %s
                           AND idempotency_key_digest = %s
                         FOR UPDATE
                        """,
                        (str(spec.user_id), spec.operation_type, spec.idempotency_key_digest),
                    )
                    row = await cur.fetchone()
                if row is None:
                    raise RuntimeError("operation registration disappeared")
                record = self._record(row)
                if record.request_hash != spec.request_hash:
                    raise IdempotencyConflict(
                        "Idempotency key reused with a different request payload"
                    )
            await conn.commit()
        return record, created

    async def get(self, operation_id: UUID, user_id: UUID) -> OperationRecord | None:
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT * FROM agent_operations WHERE id = %s AND user_id = %s",
                    (str(operation_id), str(user_id)),
                )
                row = await cur.fetchone()
        return self._record(row) if row else None

    async def claim(
        self, operation_id: UUID, user_id: UUID, executor_id: str, *, lease_seconds: int
    ) -> OperationClaim:
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT * FROM agent_operations WHERE id = %s AND user_id = %s FOR UPDATE",
                    (str(operation_id), str(user_id)),
                )
                row = await cur.fetchone()
                if row is None:
                    raise KeyError(operation_id)
                record = self._record(row)
                now = datetime.now(UTC)
                if (
                    record.status in TERMINAL_STATUSES
                    or record.status == OperationStatus.WAITING_USER
                ):
                    return OperationClaim(record, None, None, None)
                if record.next_attempt_at and record.next_attempt_at > now:
                    return OperationClaim(record, None, None, None)
                lease_live = record.lease_expires_at is not None and record.lease_expires_at > now
                if (
                    record.status in {OperationStatus.RUNNING, OperationStatus.RECONCILING}
                    and lease_live
                ):
                    return OperationClaim(record, None, None, None)
                phase = AttemptPhase.EXECUTE
                if record.status == OperationStatus.RECONCILING or (
                    record.status == OperationStatus.RUNNING
                    and not lease_live
                    and record.effect_class in WRITE_EFFECTS
                ):
                    phase = AttemptPhase.RECONCILE
                counter = "attempt_count" if phase == AttemptPhase.EXECUTE else "reconcile_count"
                target = (
                    OperationStatus.RUNNING
                    if phase == AttemptPhase.EXECUTE
                    else OperationStatus.RECONCILING
                )
                await cur.execute(
                    f"""
                    UPDATE agent_operations
                       SET status = %s, {counter} = {counter} + 1,
                           next_attempt_at = NULL, lease_owner = %s,
                           lease_expires_at = now() + (%s * interval '1 second'),
                           updated_at = now()
                     WHERE id = %s
                     RETURNING *
                    """,
                    (target.value, executor_id, lease_seconds, str(operation_id)),
                )
                claimed_row = await cur.fetchone()
                if claimed_row is None:
                    raise RuntimeError("failed to claim operation")
                claimed = self._record(claimed_row)
            await conn.commit()
        number = claimed.attempt_count if phase == AttemptPhase.EXECUTE else claimed.reconcile_count
        return OperationClaim(claimed, phase, number, now)

    async def record_attempt(
        self,
        claim: OperationClaim,
        *,
        executor_id: str,
        outcome: AttemptOutcome,
        error: ClassifiedError | None = None,
        retry_delay_ms: int | None = None,
        trace_id: str | None = None,
        observation: Mapping[str, Any] | None = None,
    ) -> None:
        if claim.phase is None or claim.attempt_no is None or claim.started_at is None:
            return
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO agent_operation_attempts (
                        operation_id, phase, attempt_no, executor_id, outcome,
                        error_class, error_code, error_message, retry_delay_ms,
                        trace_id, observation, started_at
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)
                    ON CONFLICT (operation_id, phase, attempt_no) DO NOTHING
                    """,
                    (
                        str(claim.record.id),
                        claim.phase.value,
                        claim.attempt_no,
                        executor_id,
                        outcome.value,
                        error.error_class.value if error else None,
                        error.code if error else None,
                        error.message if error else None,
                        retry_delay_ms,
                        trace_id,
                        canonical_json(observation or {}),
                        claim.started_at,
                    ),
                )
            await conn.commit()

    async def transition(
        self,
        operation_id: UUID,
        user_id: UUID,
        *,
        status: OperationStatus,
        result: Any = None,
        error: ClassifiedError | None = None,
        next_attempt_at: datetime | None = None,
        expected_lease_owner: str | None = None,
    ) -> OperationRecord:
        async with await self._connect() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE agent_operations
                       SET status = %s, result = %s::jsonb,
                           error_class = %s, error_code = %s, error_message = %s,
                           next_attempt_at = %s, lease_owner = NULL,
                           lease_expires_at = NULL, updated_at = now(),
                           completed_at = CASE
                               WHEN %s IN ('succeeded','failed','cancelled') THEN now()
                               ELSE NULL
                           END
                     WHERE id = %s AND user_id = %s
                       AND (%s::text IS NULL OR lease_owner = %s)
                     RETURNING *
                    """,
                    (
                        status.value,
                        canonical_json(result) if result is not None else None,
                        error.error_class.value if error else None,
                        error.code if error else None,
                        error.message if error else None,
                        next_attempt_at,
                        status.value,
                        str(operation_id),
                        str(user_id),
                        expected_lease_owner,
                        expected_lease_owner,
                    ),
                )
                row = await cur.fetchone()
                if row is None:
                    await cur.execute(
                        "SELECT * FROM agent_operations WHERE id = %s AND user_id = %s",
                        (str(operation_id), str(user_id)),
                    )
                    row = await cur.fetchone()
                    if row is None:
                        raise KeyError(operation_id)
            await conn.commit()
        return self._record(row)


_STORE: OperationStore | None = None
_STORE_MODE: tuple[str, str] | None = None
_STORE_OVERRIDE = False


def get_operation_store() -> OperationStore:
    global _STORE, _STORE_MODE
    if _STORE_OVERRIDE and _STORE is not None:
        return _STORE

    dsn = os.environ.get("RELAY_PG_DSN", "").strip()
    # MCP protocol tests/demo mode use an in-memory Career Graph whose
    # synthetic user intentionally has no row in the real users table.
    # Keep both halves of that fake world in memory even when a developer
    # shell also exports RELAY_PG_DSN. Re-evaluate the mode because test and
    # worker processes can legitimately change these runtime settings.
    mode = (
        ("fake", "")
        if os.environ.get("RELAY_MCP_FAKE") == "1"
        else ("postgres", dsn)
        if dsn
        else ("memory", "")
    )
    if _STORE is None or _STORE_MODE != mode:
        _STORE = PostgresOperationStore(dsn) if mode[0] == "postgres" else InMemoryOperationStore()
        _STORE_MODE = mode
    return _STORE


def set_operation_store_for_tests(store: OperationStore | None) -> None:
    global _STORE, _STORE_MODE, _STORE_OVERRIDE
    _STORE = store
    _STORE_MODE = None
    _STORE_OVERRIDE = store is not None


_OPERATION_ID: contextvars.ContextVar[UUID | None] = contextvars.ContextVar(
    "relay_operation_id", default=None
)


def current_operation_id() -> UUID | None:
    return _OPERATION_ID.get()


async def execute_with_recovery(
    spec: OperationSpec,
    execute: Callable[[], Awaitable[Any]],
    *,
    reconcile: Callable[[], Awaitable[ReconcileResult]] | None = None,
    store: OperationStore | None = None,
    executor_id: str | None = None,
    trace_id: str | None = None,
    inline_retries: bool = False,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    random_fn: Callable[[], float] = random.random,
    propagate_exceptions: tuple[type[BaseException], ...] = (),
) -> dict[str, Any]:
    """Execute at most one claimed attempt unless ``inline_retries`` is enabled."""

    operation_store = store or get_operation_store()
    executor = executor_id or f"pid:{os.getpid()}:{uuid4()}"
    record, _ = await operation_store.register(spec)
    started = time.monotonic()

    while True:
        claim = await operation_store.claim(
            record.id, spec.user_id, executor, lease_seconds=spec.lease_seconds
        )
        record = claim.record
        if claim.phase is None:
            return operation_envelope(record)

        if claim.phase == AttemptPhase.RECONCILE:
            if reconcile is None:
                error = ClassifiedError(
                    ErrorClass.AMBIGUOUS_EFFECT,
                    "RECONCILIATION_REQUIRED",
                    "No read-only reconciler is registered for this operation",
                )
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.WAITING_USER,
                    error=error,
                    expected_lease_owner=executor,
                )
                return operation_envelope(record)
            reconcile_token = _OPERATION_ID.set(record.id)
            try:
                reconciled = await reconcile()
            except BaseException as exc:  # noqa: BLE001 - recovery boundary
                error = classify_error(exc)
                attempt_no = claim.attempt_no or 1
                retryable = error.error_class in {
                    ErrorClass.TRANSIENT,
                    ErrorClass.THROTTLED,
                }
                delay = (
                    compute_backoff_ms(
                        RECONCILE_POLICY,
                        attempt_no,
                        retry_after_ms=error.retry_after_ms,
                        random_fn=random_fn,
                    )
                    if retryable and attempt_no < RECONCILE_POLICY.max_attempts
                    else None
                )
                await operation_store.record_attempt(
                    claim,
                    executor_id=executor,
                    outcome=AttemptOutcome.FAILED,
                    error=error,
                    retry_delay_ms=delay,
                    trace_id=trace_id,
                )
                if delay is None:
                    status = OperationStatus.WAITING_USER
                    next_at = None
                else:
                    status = OperationStatus.RECONCILING
                    next_at = datetime.now(UTC) + timedelta(milliseconds=delay)
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=status,
                    error=error,
                    next_attempt_at=next_at,
                    expected_lease_owner=executor,
                )
                if isinstance(exc, asyncio.CancelledError):
                    raise
                return operation_envelope(record)
            finally:
                _OPERATION_ID.reset(reconcile_token)

            await operation_store.record_attempt(
                claim,
                executor_id=executor,
                outcome=(
                    AttemptOutcome.SUCCEEDED
                    if reconciled.outcome == ReconcileOutcome.APPLIED
                    else AttemptOutcome.UNKNOWN
                ),
                trace_id=trace_id,
                observation=reconciled.observation,
            )
            if reconciled.outcome == ReconcileOutcome.APPLIED:
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.SUCCEEDED,
                    result=reconciled.result,
                    expected_lease_owner=executor,
                )
                return operation_envelope(record)
            if reconciled.outcome == ReconcileOutcome.NOT_APPLIED and (
                spec.effect_class == EffectClass.LOCAL_WRITE
            ):
                error = ClassifiedError(
                    ErrorClass.TRANSIENT,
                    "EFFECT_NOT_APPLIED",
                    "Reconciliation proved the local write was not applied",
                )
                policy = RETRY_POLICIES[ErrorClass.TRANSIENT]
                if record.attempt_count < policy.max_attempts:
                    delay = compute_backoff_ms(policy, record.attempt_count, random_fn=random_fn)
                    record = await operation_store.transition(
                        record.id,
                        spec.user_id,
                        status=OperationStatus.WAITING_RETRY,
                        error=error,
                        next_attempt_at=datetime.now(UTC) + timedelta(milliseconds=delay),
                        expected_lease_owner=executor,
                    )
                    return operation_envelope(record)
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.FAILED,
                    error=error,
                    expected_lease_owner=executor,
                )
                return operation_envelope(record)
            error = ClassifiedError(
                ErrorClass.AMBIGUOUS_EFFECT,
                "EFFECT_INCONCLUSIVE",
                "Read-only reconciliation could not prove the final effect",
            )
            if (
                reconciled.outcome == ReconcileOutcome.INCONCLUSIVE
                and (claim.attempt_no or 1) < RECONCILE_POLICY.max_attempts
            ):
                delay = compute_backoff_ms(
                    RECONCILE_POLICY, claim.attempt_no or 1, random_fn=random_fn
                )
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.RECONCILING,
                    error=error,
                    next_attempt_at=datetime.now(UTC) + timedelta(milliseconds=delay),
                    expected_lease_owner=executor,
                )
            else:
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.WAITING_USER,
                    error=error,
                    expected_lease_owner=executor,
                )
            return operation_envelope(record)

        token = _OPERATION_ID.set(record.id)
        try:
            result = await execute()
        except BaseException as exc:  # noqa: BLE001 - operation boundary
            error = classify_error(exc)
            if isinstance(exc, asyncio.CancelledError):
                is_write = spec.effect_class in WRITE_EFFECTS
                await operation_store.record_attempt(
                    claim,
                    executor_id=executor,
                    outcome=AttemptOutcome.UNKNOWN if is_write else AttemptOutcome.FAILED,
                    error=error,
                    trace_id=trace_id,
                )
                await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=(OperationStatus.RECONCILING if is_write else OperationStatus.CANCELLED),
                    error=error,
                    expected_lease_owner=executor,
                )
                raise
            if isinstance(exc, propagate_exceptions):
                await operation_store.record_attempt(
                    claim,
                    executor_id=executor,
                    outcome=AttemptOutcome.FAILED,
                    error=error,
                    trace_id=trace_id,
                )
                await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.WAITING_USER,
                    error=error,
                    expected_lease_owner=executor,
                )
                raise
            retry_policy = _policy_for(error)
            should_reconcile = error.error_class == ErrorClass.AMBIGUOUS_EFFECT or (
                spec.effect_class in WRITE_EFFECTS
                and error.error_class in {ErrorClass.TRANSIENT, ErrorClass.THROTTLED}
            )
            if should_reconcile:
                await operation_store.record_attempt(
                    claim,
                    executor_id=executor,
                    outcome=AttemptOutcome.UNKNOWN,
                    error=error,
                    trace_id=trace_id,
                )
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.RECONCILING,
                    error=error,
                    expected_lease_owner=executor,
                )
                return operation_envelope(record)

            retry_delay = None
            can_retry = (
                retry_policy is not None and record.attempt_count < retry_policy.max_attempts
            )
            if can_retry and retry_policy is not None:
                retry_delay = compute_backoff_ms(
                    retry_policy,
                    record.attempt_count,
                    retry_after_ms=error.retry_after_ms,
                    random_fn=random_fn,
                )
            await operation_store.record_attempt(
                claim,
                executor_id=executor,
                outcome=AttemptOutcome.FAILED,
                error=error,
                retry_delay_ms=retry_delay,
                trace_id=trace_id,
            )
            if can_retry and retry_delay is not None:
                next_at = datetime.now(UTC) + timedelta(milliseconds=retry_delay)
                record = await operation_store.transition(
                    record.id,
                    spec.user_id,
                    status=OperationStatus.WAITING_RETRY,
                    error=error,
                    next_attempt_at=next_at,
                    expected_lease_owner=executor,
                )
                within_window = time.monotonic() - started < spec.max_elapsed_seconds
                if inline_retries and within_window:
                    await sleep(retry_delay / 1000)
                    continue
                return operation_envelope(record)

            waiting = error.error_class in {
                ErrorClass.AUTH,
                ErrorClass.VALIDATION,
                ErrorClass.POLICY,
                ErrorClass.CAPTCHA,
                ErrorClass.USER_REJECTED,
                ErrorClass.CONFLICT,
                ErrorClass.STALE_STATE,
                ErrorClass.UNKNOWN,
            }
            record = await operation_store.transition(
                record.id,
                spec.user_id,
                status=OperationStatus.WAITING_USER if waiting else OperationStatus.FAILED,
                error=error,
                expected_lease_owner=executor,
            )
            return operation_envelope(record)
        finally:
            _OPERATION_ID.reset(token)

        await operation_store.record_attempt(
            claim,
            executor_id=executor,
            outcome=AttemptOutcome.SUCCEEDED,
            trace_id=trace_id,
        )
        record = await operation_store.transition(
            record.id,
            spec.user_id,
            status=OperationStatus.SUCCEEDED,
            result=result,
            expected_lease_owner=executor,
        )
        return operation_envelope(record)


async def get_operation_envelope(
    operation_id: UUID, user_id: UUID, *, store: OperationStore | None = None
) -> dict[str, Any] | None:
    record = await (store or get_operation_store()).get(operation_id, user_id)
    return operation_envelope(record) if record else None


async def reconcile_existing_operation(
    operation_id: UUID,
    user_id: UUID,
    reconcile: Callable[[OperationRecord], Awaitable[ReconcileResult]],
    *,
    store: OperationStore | None = None,
    executor_id: str | None = None,
    trace_id: str | None = None,
    random_fn: Callable[[], float] = random.random,
) -> dict[str, Any] | None:
    """Run one read-only reconciliation attempt for an existing operation.

    This never invokes the original side effect. It is the safe external MCP
    entry point after a Codex/Claude Code session or transport was interrupted.
    """

    operation_store = store or get_operation_store()
    record = await operation_store.get(operation_id, user_id)
    if record is None:
        return None
    if record.status not in {OperationStatus.RECONCILING, OperationStatus.RUNNING}:
        return operation_envelope(record)

    executor = executor_id or f"reconcile:{os.getpid()}:{uuid4()}"
    claim = await operation_store.claim(operation_id, user_id, executor, lease_seconds=30)
    if claim.phase is None:
        return operation_envelope(claim.record)
    if claim.phase != AttemptPhase.RECONCILE:
        # Explicit reconciliation must never turn a pending safe retry into an
        # execution. Release it back to its prior retry state.
        record = await operation_store.transition(
            operation_id,
            user_id,
            status=OperationStatus.WAITING_RETRY,
            error=ClassifiedError(
                ErrorClass.TRANSIENT,
                "EXECUTION_RETRY_PENDING",
                "The next step is an execution retry, not reconciliation",
            ),
            expected_lease_owner=executor,
        )
        return operation_envelope(record)

    reconcile_token = _OPERATION_ID.set(claim.record.id)
    try:
        result = await reconcile(claim.record)
    except BaseException as exc:  # noqa: BLE001 - reconciliation boundary
        error = classify_error(exc)
        attempt_no = claim.attempt_no or 1
        retryable = error.error_class in {
            ErrorClass.TRANSIENT,
            ErrorClass.THROTTLED,
        }
        delay = (
            compute_backoff_ms(
                RECONCILE_POLICY,
                attempt_no,
                retry_after_ms=error.retry_after_ms,
                random_fn=random_fn,
            )
            if retryable and attempt_no < RECONCILE_POLICY.max_attempts
            else None
        )
        await operation_store.record_attempt(
            claim,
            executor_id=executor,
            outcome=AttemptOutcome.FAILED,
            error=error,
            retry_delay_ms=delay,
            trace_id=trace_id,
        )
        record = await operation_store.transition(
            operation_id,
            user_id,
            status=OperationStatus.WAITING_USER if delay is None else OperationStatus.RECONCILING,
            error=error,
            next_attempt_at=(
                None if delay is None else datetime.now(UTC) + timedelta(milliseconds=delay)
            ),
            expected_lease_owner=executor,
        )
        if isinstance(exc, asyncio.CancelledError):
            raise
        return operation_envelope(record)
    finally:
        _OPERATION_ID.reset(reconcile_token)

    await operation_store.record_attempt(
        claim,
        executor_id=executor,
        outcome=(
            AttemptOutcome.SUCCEEDED
            if result.outcome == ReconcileOutcome.APPLIED
            else AttemptOutcome.UNKNOWN
        ),
        trace_id=trace_id,
        observation=result.observation,
    )
    if result.outcome == ReconcileOutcome.APPLIED:
        record = await operation_store.transition(
            operation_id,
            user_id,
            status=OperationStatus.SUCCEEDED,
            result=result.result,
            expected_lease_owner=executor,
        )
        return operation_envelope(record)
    if (
        result.outcome == ReconcileOutcome.NOT_APPLIED
        and record.effect_class == EffectClass.LOCAL_WRITE
    ):
        error = ClassifiedError(
            ErrorClass.TRANSIENT,
            "EFFECT_NOT_APPLIED",
            "Reconciliation proved the local write was not applied",
        )
        policy = RETRY_POLICIES[ErrorClass.TRANSIENT]
        if record.attempt_count < policy.max_attempts:
            delay = compute_backoff_ms(policy, record.attempt_count, random_fn=random_fn)
            record = await operation_store.transition(
                operation_id,
                user_id,
                status=OperationStatus.WAITING_RETRY,
                error=error,
                next_attempt_at=datetime.now(UTC) + timedelta(milliseconds=delay),
                expected_lease_owner=executor,
            )
        else:
            record = await operation_store.transition(
                operation_id,
                user_id,
                status=OperationStatus.FAILED,
                error=error,
                expected_lease_owner=executor,
            )
        return operation_envelope(record)

    error = ClassifiedError(
        ErrorClass.AMBIGUOUS_EFFECT,
        "EFFECT_INCONCLUSIVE",
        "Read-only reconciliation could not prove the final effect",
    )
    if (
        result.outcome == ReconcileOutcome.INCONCLUSIVE
        and (claim.attempt_no or 1) < RECONCILE_POLICY.max_attempts
    ):
        delay = compute_backoff_ms(
            RECONCILE_POLICY,
            claim.attempt_no or 1,
            random_fn=random_fn,
        )
        record = await operation_store.transition(
            operation_id,
            user_id,
            status=OperationStatus.RECONCILING,
            error=error,
            next_attempt_at=datetime.now(UTC) + timedelta(milliseconds=delay),
            expected_lease_owner=executor,
        )
        return operation_envelope(record)
    record = await operation_store.transition(
        operation_id,
        user_id,
        status=OperationStatus.WAITING_USER,
        error=error,
        expected_lease_owner=executor,
    )
    return operation_envelope(record)
