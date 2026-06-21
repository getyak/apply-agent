-- 016 down: remove atomic version assignment trigger.
-- Existing rows keep whatever version they have; writers fall back to
-- application-level MAX+1 (which is what they did pre-016).

DROP TRIGGER IF EXISTS trg_resumes_assign_version ON resumes;
DROP FUNCTION IF EXISTS assign_resume_version();
