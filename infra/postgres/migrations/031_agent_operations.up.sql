-- 031 up: durable operation ledger for Relay agents and external MCP clients.
--
-- agent_tasks remains an append-only audit/cost record.  These tables own the
-- mutable execution truth required for idempotency, leases, reconciliation,
-- and classified retry decisions across Relay, Codex, and Claude Code.

BEGIN;

CREATE TABLE agent_operations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_type          TEXT NOT NULL,
    actor_type              TEXT NOT NULL CHECK (
        actor_type IN ('relay', 'codex', 'claude_code', 'mcp', 'browser_extension')
    ),
    effect_class            TEXT NOT NULL CHECK (
        effect_class IN ('read', 'compute', 'local_write', 'external_write')
    ),
    idempotency_key_digest  TEXT NOT NULL CHECK (length(idempotency_key_digest) = 64),
    request_hash            TEXT NOT NULL CHECK (length(request_hash) = 64),
    request_summary         JSONB NOT NULL DEFAULT '{}',
    resource_ref            JSONB NOT NULL DEFAULT '{}',
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending', 'running', 'reconciling', 'waiting_retry',
            'waiting_user', 'succeeded', 'failed', 'cancelled'
        )
    ),
    result                  JSONB,
    error_class             TEXT CHECK (
        error_class IS NULL OR error_class IN (
            'transient', 'throttled', 'ambiguous_effect', 'conflict',
            'stale_state', 'auth', 'validation', 'policy', 'captcha',
            'user_rejected', 'budget', 'content_refused',
            'fabrication_blocked', 'cancelled', 'permanent', 'unknown'
        )
    ),
    error_code              TEXT,
    error_message           TEXT,
    attempt_count           INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    reconcile_count         INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_count >= 0),
    next_attempt_at         TIMESTAMPTZ,
    lease_owner             TEXT,
    lease_expires_at        TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ,
    UNIQUE (user_id, operation_type, idempotency_key_digest)
);

CREATE INDEX idx_agent_operations_due
    ON agent_operations(status, next_attempt_at)
    WHERE status IN ('pending', 'waiting_retry', 'reconciling');

CREATE INDEX idx_agent_operations_expired_lease
    ON agent_operations(lease_expires_at)
    WHERE status IN ('running', 'reconciling');

CREATE INDEX idx_agent_operations_user_recent
    ON agent_operations(user_id, created_at DESC);

CREATE TABLE agent_operation_attempts (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id        UUID NOT NULL REFERENCES agent_operations(id) ON DELETE CASCADE,
    phase               TEXT NOT NULL CHECK (phase IN ('execute', 'reconcile')),
    attempt_no          INTEGER NOT NULL CHECK (attempt_no > 0),
    executor_id         TEXT NOT NULL,
    outcome             TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'unknown')),
    error_class         TEXT,
    error_code          TEXT,
    error_message       TEXT,
    retry_delay_ms      INTEGER CHECK (retry_delay_ms IS NULL OR retry_delay_ms >= 0),
    trace_id            TEXT,
    observation         JSONB NOT NULL DEFAULT '{}',
    started_at          TIMESTAMPTZ NOT NULL,
    completed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (operation_id, phase, attempt_no)
);

CREATE INDEX idx_agent_operation_attempts_operation
    ON agent_operation_attempts(operation_id, completed_at DESC);

-- Bind the short-lived browser authorization receipt to the durable operation
-- which issued it.  This makes an interrupted post-commit response
-- reconcilable without minting a second receipt.
ALTER TABLE application_submission_authorizations
    ADD COLUMN operation_id UUID REFERENCES agent_operations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_application_submission_authorizations_operation
    ON application_submission_authorizations(operation_id)
    WHERE operation_id IS NOT NULL;

ALTER TABLE agent_tasks
    ADD COLUMN operation_id UUID REFERENCES agent_operations(id) ON DELETE SET NULL;

CREATE INDEX idx_agent_tasks_operation
    ON agent_tasks(operation_id)
    WHERE operation_id IS NOT NULL;

COMMENT ON TABLE agent_operations IS
    'Durable idempotency, lease, retry, and reconciliation truth for agent operations.';
COMMENT ON COLUMN agent_operations.idempotency_key_digest IS
    'SHA-256 of the caller key; raw idempotency keys are never persisted or logged.';
COMMENT ON COLUMN agent_operations.request_hash IS
    'SHA-256 of canonical request JSON; same key with a different hash is rejected.';
COMMENT ON TABLE agent_operation_attempts IS
    'Append-only execution and reconciliation evidence for one durable operation.';
COMMENT ON COLUMN application_submission_authorizations.operation_id IS
    'Durable operation which issued this browser-click authorization receipt.';

COMMIT;
