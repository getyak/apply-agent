-- 016 up: atomic per-user resume version assignment
--
-- Problem this fixes: "duplicate key value violates unique constraint
-- resumes_user_id_version_key" surfaced during onboarding.
--
-- Root cause: every writer (api/src/routes/resumes.ts, agents/tools/notify.py,
-- agents/api/server.py) computed `version = SELECT MAX(version)+1` in
-- application code, then INSERTed. Two concurrent writers for the same user
-- read the same MAX and tried to commit the same version → 23505.
-- Onboarding triggers this easily: the async parse-job + a user-driven retry
-- (or React strict-mode double-fire) hit it almost every time.
--
-- Fix: the database assigns the version inside a BEFORE INSERT trigger that
-- takes a per-user advisory lock for the transaction. Concurrent inserts for
-- the same user serialise; concurrent inserts across users never block.
-- Writers may now pass version = 0 / NULL and let the DB decide.
--
-- We also keep the UNIQUE(user_id, version) constraint as a safety net —
-- if someone bypasses the trigger by passing a non-zero version, the
-- constraint still catches collisions. The trigger only assigns when the
-- caller hasn't picked a version, so legacy code paths that DO pick one
-- (e.g. tailored variant creation that needs a specific parent_version
-- relationship) keep working.

CREATE OR REPLACE FUNCTION assign_resume_version() RETURNS trigger AS $$
BEGIN
    IF NEW.version IS NULL OR NEW.version = 0 THEN
        -- Advisory lock keyed on user_id: hashtext gives us a stable 32-bit
        -- int for the user's UUID. xact_lock auto-releases at commit/rollback.
        -- Same user → serialised; different users → independent.
        PERFORM pg_advisory_xact_lock(hashtext('relay:resume_version:' || NEW.user_id::text));
        SELECT COALESCE(MAX(version), 0) + 1 INTO NEW.version
            FROM resumes WHERE user_id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_resumes_assign_version
    BEFORE INSERT ON resumes
    FOR EACH ROW EXECUTE FUNCTION assign_resume_version();
