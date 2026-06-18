-- 008: Memory domain — rollback
-- Reverse of 008_memories.sql. Drops the memory graph (memory_relations)
-- before the nodes (user_memories) so FK ordering is unambiguous; CASCADE
-- is implicit because relations references memories.
--
-- The shared update_updated_at() function is owned by 002 and reused
-- across migrations; the trigger we created here is bound to user_memories
-- and is dropped automatically with the table.

DROP INDEX IF EXISTS idx_memories_embedding;
DROP INDEX IF EXISTS idx_memories_user_type;
DROP TABLE IF EXISTS memory_relations;
DROP TABLE IF EXISTS user_memories;
