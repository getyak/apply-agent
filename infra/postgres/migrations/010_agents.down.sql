-- 010: Agents domain — rollback
-- Reverse of 010_agents.sql. Drops agent_tasks (HITL queue) and
-- agent_configs (prompt registry) plus their indexes.

DROP INDEX IF EXISTS idx_agent_tasks_pending;
DROP INDEX IF EXISTS idx_agent_tasks_session;
DROP INDEX IF EXISTS idx_agent_tasks_user;
DROP TABLE IF EXISTS agent_tasks;
DROP TABLE IF EXISTS agent_configs;
