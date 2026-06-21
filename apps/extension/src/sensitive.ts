// EXT_SEC1 (round-15): client-side sensitive-field deny-list.
//
// Until round-15 the extension's only line of defense against shipping
// race / disability / SSN / DOB fields to the cloud LLM was the server
// (agents/nodes/appprep_agent.SENSITIVE_TOKENS, extended in round-13).
// That's a single point of failure — if the client somehow bypasses the
// server (network split, popup-side filler, future endpoint that skips
// the appprep guard) the sensitive value still reaches the LLM.
//
// This module mirrors the server-side list almost verbatim so the
// content script can refuse to even *attempt* a local fill for a
// sensitive field, and so unmatched sensitive fields never end up in
// the cloud-fill payload as "this field needs LLM help". The match
// policy matches the Python side: case-insensitive substring against
// the field haystack (label + placeholder + name attribute).
//
// Caller: local-fill.planLocalFill() drops sensitive fields onto the
// `unmatched` list with no further attempt; content.ts then strips
// sensitive entries from `unmatched` before handing them to
// fetchCloudFills(). The user still sees these as fields they must
// answer themselves — the extension simply refuses to guess or upload
// them.

/**
 * Substring tokens that mark a form field as off-limits for any
 * automatic fill or cloud upload. Kept lowercase. Each entry should
 * appear verbatim somewhere in (label + placeholder + name) for at
 * least one common ATS template — we err on the side of more, not
 * fewer, because the cost of false-positive (user fills the field
 * themselves) is way smaller than the cost of leaking PII.
 *
 * Round-13 added the equivalent list to the server (agents/nodes/
 * appprep_agent.SENSITIVE_TOKENS); keep both lists in sync until
 * round-N extracts the shared policy into a JSON config that both
 * runtimes load. New entries here should be mirrored back to Python
 * (and vice versa) in the same commit when possible.
 */
export const SENSITIVE_FIELD_TOKENS: ReadonlyArray<string> = [
  // EEO / demographic — Workday and Greenhouse panels use these labels.
  'race',
  'ethnicity',
  'gender',
  'gender identity',
  'sex',
  'disability',
  'veteran',
  'sexual orientation',
  'religion',
  'marital status',
  // Government ids — broadly sensitive across jurisdictions.
  'ssn',
  'social security',
  'social security number',
  'citizenship',
  'visa',
  'passport',
  'national id',
  'national insurance',
  'tax id',
  'tin',
  // Date of birth and aliases.
  'date of birth',
  'dob',
  'birth date',
  'birthdate',
  // Driver's license / state ID variants.
  "driver's license",
  'drivers license',
  'license number',
];

/**
 * True when any sensitive token appears in `haystack`. Caller is
 * expected to lowercase the haystack first (local-fill builds the
 * same lowercased composite from label + placeholder + name attribute).
 */
export function isSensitiveLabel(haystack: string): boolean {
  for (const token of SENSITIVE_FIELD_TOKENS) {
    if (haystack.includes(token)) return true;
  }
  return false;
}
