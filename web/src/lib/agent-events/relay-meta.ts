/**
 * extractRelayMeta — single read entry point for the envelope Relay injects
 * into every AG-UI event via `event.rawEvent`.
 *
 * Why a helper file (instead of inline reads)
 * --------------------------------------------
 * 1. Defends against the SDK upgrade where `rawEvent` may be omitted or
 *    re-shaped: failures fall back to a safe "empty meta" with derived seq=0.
 * 2. Centralizes the snake_case keys (`trace_id`, `step_id`, …) that exist
 *    only inside rawEvent — top-level fields are camelCase because Pydantic
 *    serializes with `by_alias=True`.
 * 3. Lets the reducer (PR3) call one function instead of repeating
 *    `evt.rawEvent?.step_id ?? evt.rawEvent?.parent_step_id ?? …` everywhere.
 *
 * Callers: web/src/lib/agent-events/reducer.ts, custom.ts, store.ts (PR3).
 */

import type { AgentEvent, RelayMeta } from "./schema";

const EMPTY_META: RelayMeta = {
  id: "",
  seq: 0,
  trace_id: "",
  run_id: "",
  thread_id: "",
  protocol_version: "",
};

/**
 * Returns the Relay envelope embedded in event.rawEvent, or an empty stub
 * (with seq=0, empty strings) if the event came from a non-Relay producer.
 *
 * Never throws.
 */
export function extractRelayMeta(event: AgentEvent): RelayMeta {
  const raw = event.rawEvent;
  if (!raw || typeof raw !== "object") return EMPTY_META;
  return raw;
}

/**
 * Compare two RelayMeta by (run_id, seq) — useful for sorting events out of
 * order. Events from different runs are never compared (return 0).
 */
export function compareBySeq(a: RelayMeta, b: RelayMeta): number {
  if (a.run_id !== b.run_id) return 0;
  return a.seq - b.seq;
}
