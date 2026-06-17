-- 008: User memory system (long-term agent memory)

CREATE TABLE user_memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory_type     TEXT NOT NULL CHECK (memory_type IN (
        'profile', 'preference', 'skill', 'experience',
        'feedback', 'interview', 'job_pref'
    )),
    content         TEXT NOT NULL,
    source_session_id UUID REFERENCES conversation_sessions(id) ON DELETE SET NULL,
    source_message_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
    embedding       vector(1536),
    importance      FLOAT NOT NULL DEFAULT 0.5,
    access_count    INT NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    superseded_by   UUID REFERENCES user_memories(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_user_type ON user_memories(user_id, memory_type)
    WHERE is_active = true;
CREATE INDEX idx_memories_embedding ON user_memories
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TRIGGER trg_memories_updated_at
    BEFORE UPDATE ON user_memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE memory_relations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL REFERENCES user_memories(id) ON DELETE CASCADE,
    target_id       UUID NOT NULL REFERENCES user_memories(id) ON DELETE CASCADE,
    relation_type   TEXT NOT NULL CHECK (relation_type IN (
        'supports', 'contradicts', 'updates', 'relates_to'
    )),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source_id, target_id, relation_type)
);
