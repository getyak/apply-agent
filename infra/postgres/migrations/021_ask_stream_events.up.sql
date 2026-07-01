-- 021 up: SSE resume-by-cursor storage for Ask Vantage.
--
-- Background: /ask/stream emits AG-UI SSE frames. When the client's
-- connection blinks (network flap, tab throttled, proxy timeout), today
-- the browser reloads the whole turn from scratch — the LangGraph run
-- may already be finishing but the client won't see any of the events
-- that were dispatched while it was disconnected. This migration lands
-- the storage substrate that lets the client reconnect with a
-- Last-Event-ID and receive only the events it missed.
--
-- Design (docs/architecture/error-handling.md §Stream resume, to be added):
--   * every SSE frame is appended to ask_stream_events with a monotonic
--     per-thread sequence number
--   * clients send the last seen sequence on reconnect (POST body field
--     ``last_event_id`` OR HTTP ``Last-Event-ID`` header — see D2 code)
--   * agents/api replays events with sequence > last_seen, then subscribes
--     to a Redis Pub/Sub channel per thread for the tail
--   * events older than the retention window (24h) or beyond the per-thread
--     cap (1000 rows) are pruned; if the client asks for a sequence that's
--     been pruned, the server returns STREAM_EXPIRED and the UI falls back
--     to "Stream expired · Start over"
--
-- Why sequence is per-thread and not per-run:
--   * A dock lifetime thread holds many runs. The client's Last-Event-ID
--     must remain valid across runs (e.g. reconnect happens mid-way through
--     the *next* turn). If we scoped sequence to run_id, the cursor would
--     reset on every run boundary and be useless.
--   * Run boundaries are still recoverable — the frame payload carries
--     run_id in its Relay envelope, so the client can tell "this event
--     belongs to a new run".

CREATE TABLE ask_stream_events (
  -- (thread_id, sequence) is the natural primary key. sequence is issued
  -- by an app-level advisory lock in the writer (D2) rather than a PG
  -- sequence: a single thread's writes are always serial (one dock turn
  -- at a time), and using an advisory lock keeps monotonicity exact
  -- across replicas.
  thread_id     TEXT   NOT NULL,
  sequence      BIGINT NOT NULL,

  -- Duplicate-detection key for the writer. RelayEmitter._meta stamps a
  -- ULID into event.raw_event.id; if the same frame is re-emitted (retry
  -- inside the emitter, resubscribe races), the UNIQUE (thread_id, event_id)
  -- index below drops the duplicate write silently.
  event_id      TEXT   NOT NULL,

  -- Provenance for observability + resume semantics.
  run_id        TEXT,
  trace_id      TEXT,

  -- The already-encoded SSE frame as it went on the wire, verbatim.
  -- BYTEA rather than TEXT because AG-UI frames can theoretically carry
  -- raw bytes (RAW event). ~2KB avg per frame; the pruner keeps this
  -- table tight (see prune_ask_stream_events()).
  frame         BYTEA  NOT NULL,

  -- SSE event: line (e.g. "heartbeat", "agui"). Optional; NULL means
  -- the frame is a bare `data:` line.
  event_name    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (thread_id, sequence)
);

-- Ordered scan by thread_id → sequence is the hot path (resume + prune).
-- The PK already covers it, so no extra index needed.

-- De-duplicate identical event_ids per thread so a re-emit is a no-op.
-- IMPORTANT: this is why the writer uses INSERT ... ON CONFLICT DO NOTHING
-- on (thread_id, event_id) instead of (thread_id, sequence). If the same
-- event tries to write twice with a fresh sequence, only the first wins.
CREATE UNIQUE INDEX ask_stream_events_event_id_uniq
  ON ask_stream_events (thread_id, event_id);

-- Retention index: prune by (created_at) < now() - 24h. BRIN keeps this
-- cheap even when the table grows.
CREATE INDEX ask_stream_events_created_at_brin
  ON ask_stream_events USING BRIN (created_at);

COMMENT ON TABLE ask_stream_events IS
  'SSE resume-by-cursor buffer for /ask/stream. Retention 24h / max 1000 rows per thread. See docs/architecture/error-handling.md §Stream resume.';

COMMENT ON COLUMN ask_stream_events.sequence IS
  'Monotonic per-thread; issued by writer via advisory lock. Not a serial (would leave gaps on rollback).';

COMMENT ON COLUMN ask_stream_events.event_id IS
  'ULID from RelayEmitter._meta.id; primary de-dup key across retries.';

COMMENT ON COLUMN ask_stream_events.frame IS
  'The already-encoded SSE frame bytes (data: {...}\n\n). Sent back verbatim on resume.';
