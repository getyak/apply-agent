-- 013 down: remove built-in Mock interview modes
--
-- Caller: CI migration-check (cicd-aiops-harness.md § 1.4) — forward / rollback / re-apply.
-- Field shape: matches 013_seed_interview_modes.up.sql (synthetic, no PII).
-- Safe: interview_sessions.mode_id is ON DELETE SET NULL, so removing modes
-- leaves any sessions intact with mode_id = NULL.

BEGIN;

DELETE FROM interview_modes
WHERE user_id IS NULL
  AND slug IN ('scene_recreation', 'pressure_drill', 'warm_up', 'rapid_fire');

COMMIT;
