-- 007: Conversation & session tables

CREATE TABLE conversation_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_type    TEXT NOT NULL CHECK (session_type IN (
        'resume_optimization', 'interview_prep', 'job_search',
        'application_prep', 'general'
    )),
    agent_type      TEXT NOT NULL CHECK (agent_type IN (
        'resume_agent', 'job_match_agent', 'interview_agent',
        'app_prep_agent', 'trend_agent', 'coordinator'
    )),
    linked_job_id   UUID REFERENCES jobs(id) ON DELETE SET NULL,
    linked_resume_id UUID REFERENCES resumes(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
        'active', 'paused', 'completed', 'expired'
    )),
    title           TEXT,
    summary         TEXT,
    total_tokens    INT NOT NULL DEFAULT 0,
    total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
    message_count   INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ
);

CREATE INDEX idx_sessions_user ON conversation_sessions(user_id, status);
CREATE INDEX idx_sessions_active ON conversation_sessions(user_id, last_active_at DESC)
    WHERE status = 'active';

CREATE TABLE conversation_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content         TEXT NOT NULL,
    tool_calls      JSONB,
    tokens_in       INT,
    tokens_out      INT,
    model_used      TEXT,
    cost_cents      NUMERIC(10,4),
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_session ON conversation_messages(session_id, created_at);
