-- 007: Conversations domain — rollback
-- Reverse of 007_conversations.sql. Drops conversation_messages before
-- conversation_sessions because messages reference sessions.
--
-- 012_vantage_ui.sql later layers an `ask_vantage` partial unique index
-- on conversation_sessions and seeds interview_modes; rolling back 007
-- requires rolling back 012 first (its own down script handles that —
-- this file deliberately doesn't reach into 012's surface).

DROP INDEX IF EXISTS idx_messages_session;
DROP TABLE IF EXISTS conversation_messages;

DROP INDEX IF EXISTS idx_sessions_active;
DROP INDEX IF EXISTS idx_sessions_user;
DROP TABLE IF EXISTS conversation_sessions;
