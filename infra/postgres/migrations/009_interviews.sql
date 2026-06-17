-- 009: Interview domain tables + crowdsourced pool

CREATE TABLE interview_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES conversation_sessions(id) ON DELETE SET NULL,
    interview_type  TEXT NOT NULL CHECK (interview_type IN ('mock', 'real_prep', 'post_mortem')),
    stage           TEXT CHECK (stage IN (
        'phone_screen', 'onsite', 'system_design', 'behavioral', 'coding', 'other'
    )),
    total_questions INT NOT NULL DEFAULT 0,
    avg_rating      FLOAT,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_interview_sessions_user ON interview_sessions(user_id);

CREATE TABLE interview_questions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
    question_order  INT NOT NULL,
    question_text   TEXT NOT NULL,
    category        TEXT NOT NULL CHECK (category IN (
        'technical', 'behavioral', 'situational', 'system_design', 'coding'
    )),
    difficulty      TEXT CHECK (difficulty IN ('easy', 'medium', 'hard')),
    user_answer     TEXT,
    ai_feedback     TEXT,
    ai_rating       INT CHECK (ai_rating BETWEEN 1 AND 5),
    ai_model_answer TEXT,
    contributed_to_pool BOOLEAN NOT NULL DEFAULT false,
    recording_file_id UUID REFERENCES user_files(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_interview_questions_session ON interview_questions(session_id, question_order);

-- crowdsourced (anonymous) question pool
CREATE TABLE interview_question_pool (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company         TEXT NOT NULL,
    role_category   TEXT NOT NULL,
    stage           TEXT,
    question_text   TEXT NOT NULL,
    category        TEXT NOT NULL,
    difficulty      TEXT,
    report_count    INT NOT NULL DEFAULT 1,
    avg_difficulty  FLOAT,
    first_seen      DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen       DATE NOT NULL DEFAULT CURRENT_DATE,
    question_hash   TEXT NOT NULL UNIQUE,
    embedding       vector(1536)
);

CREATE INDEX idx_pool_company_role ON interview_question_pool(company, role_category);
CREATE INDEX idx_pool_embedding ON interview_question_pool
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
