-- 031 down: remove the durable agent operation ledger.

BEGIN;

DROP INDEX IF EXISTS idx_application_submission_authorizations_operation;
ALTER TABLE application_submission_authorizations DROP COLUMN IF EXISTS operation_id;

DROP INDEX IF EXISTS idx_agent_tasks_operation;
ALTER TABLE agent_tasks DROP COLUMN IF EXISTS operation_id;

DROP TABLE IF EXISTS agent_operation_attempts;
DROP TABLE IF EXISTS agent_operations;

COMMIT;
