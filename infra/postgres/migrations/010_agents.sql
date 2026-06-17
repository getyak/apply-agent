-- 010: Agent runtime tables

CREATE TABLE agent_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_type      TEXT NOT NULL,
    version         INT NOT NULL,
    system_prompt   TEXT NOT NULL,
    tool_permissions JSONB NOT NULL DEFAULT '{"auto": [], "notify": [], "approve": [], "block": []}',
    default_model   TEXT NOT NULL DEFAULT 'sonnet',
    temperature     FLOAT DEFAULT 0.3,
    max_tokens      INT DEFAULT 4096,
    guards          JSONB NOT NULL DEFAULT '{
        "max_iterations": 20,
        "token_budget": 80000,
        "cost_limit_cents": 50,
        "timeout_seconds": 300,
        "max_consecutive_errors": 3
    }',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(agent_type, version)
);

CREATE TABLE agent_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      UUID REFERENCES conversation_sessions(id) ON DELETE SET NULL,
    agent_type      TEXT NOT NULL,
    agent_version   INT NOT NULL DEFAULT 1,
    action          TEXT NOT NULL,
    input_params    JSONB NOT NULL DEFAULT '{}',
    output_result   JSONB,
    iterations      INT NOT NULL DEFAULT 0,
    max_iterations  INT NOT NULL DEFAULT 20,
    react_trace     JSONB,
    total_tokens    INT NOT NULL DEFAULT 0,
    total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
    latency_ms      INT,
    model_used      TEXT,
    cache_hit       BOOLEAN DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'waiting_approval', 'completed', 'failed', 'timeout', 'cancelled'
    )),
    error_message   TEXT,
    error_count     INT NOT NULL DEFAULT 0,
    hitl_action     TEXT,
    hitl_payload    JSONB,
    hitl_decision   TEXT CHECK (hitl_decision IN ('approved', 'rejected', 'timeout')),
    hitl_decided_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_agent_tasks_user ON agent_tasks(user_id, status);
CREATE INDEX idx_agent_tasks_session ON agent_tasks(session_id);
CREATE INDEX idx_agent_tasks_pending ON agent_tasks(status, created_at)
    WHERE status IN ('pending', 'running', 'waiting_approval');
