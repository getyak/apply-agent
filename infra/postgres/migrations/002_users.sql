-- 002: User domain tables

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    display_name    TEXT,
    avatar_url      TEXT,
    preferences     JSONB NOT NULL DEFAULT '{}',
    quota           JSONB NOT NULL DEFAULT '{"monthly_apps": 100, "monthly_llm_cents": 500}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type     TEXT NOT NULL CHECK (device_type IN ('chrome_extension', 'web', 'mobile')),
    device_name     TEXT,
    last_sync_at    TIMESTAMPTZ,
    push_token      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_devices_user ON user_devices(user_id);

-- auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
