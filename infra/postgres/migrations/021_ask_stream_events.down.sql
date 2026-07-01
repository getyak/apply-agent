-- 021 down: drop SSE resume-by-cursor storage.
--
-- Safe to rollback: the writer treats a missing table as "resume disabled"
-- and degrades to the pre-021 behaviour (fresh stream on every reconnect).

DROP INDEX IF EXISTS ask_stream_events_created_at_brin;
DROP INDEX IF EXISTS ask_stream_events_event_id_uniq;
DROP TABLE IF EXISTS ask_stream_events;
