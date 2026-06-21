// Local field filler — maps DetectedField to UserProfile value with regex
// heuristics over (label, placeholder, name). Returns a FillPlan that the
// content-script applies with human-ish timing.
//
// "Local" means zero network, zero LLM. The cloud filler (Task T7) runs on
// the leftovers — fields without a confident local match.
//
// Caller: content.ts on user-triggered fill ("Fill with profile" button in
// the popup). The mapper is also unit-tested in popup-only stubs.

import type { DetectedField } from './ats-detect.js';
import type { UserProfile } from './profile.js';
import { isSensitiveLabel } from './sensitive.js';

export interface FillInstruction {
  /** Selector handed back from detectFields(). */
  selector: string;
  /** Which profile slot fed this answer (for the highlight + audit trail). */
  profileKey: keyof UserProfile;
  /** The value to write into the input. */
  value: string;
  /** Field type, drives the keystroke vs change-event strategy. */
  type: DetectedField['type'];
  /** 0-1 confidence; below 0.6 the filler still suggests but visibly flags. */
  confidence: number;
}

export interface FillPlan {
  fills: FillInstruction[];
  /** Field ids the local mapper could not handle — caller can ship to LLM. */
  unmatched: DetectedField[];
  /**
   * EXT_SEC1 (round-15): fields the planner refused to even attempt
   * because they matched the client-side sensitive deny-list
   * (sensitive.ts SENSITIVE_FIELD_TOKENS). These are deliberately kept
   * *separate* from `unmatched` so the caller (content.ts) cannot
   * accidentally ship them to the cloud-fill endpoint. The user fills
   * these themselves — the extension never touches them.
   */
  skippedSensitive: DetectedField[];
}

/** Patterns are ordered: higher specificity first wins. */
interface Rule {
  // Match against (label + placeholder + name) joined and lower-cased.
  pattern: RegExp;
  profileKey: keyof UserProfile;
  // Optional gate on field type — refuse the rule if type doesn't match.
  allowedTypes?: ReadonlyArray<DetectedField['type']>;
  confidence: number;
}

const RULES: ReadonlyArray<Rule> = [
  // Email — most distinctive, do first.
  { pattern: /\b(?:e[-\s]?mail|email\s*address)\b/, profileKey: 'email', allowedTypes: ['email', 'text'], confidence: 0.95 },
  // Phone variants
  { pattern: /\b(?:phone|mobile|tel(?:ephone)?|cell)\b/, profileKey: 'phone', allowedTypes: ['tel', 'text'], confidence: 0.95 },
  // LinkedIn / GitHub / portfolio / personal site
  { pattern: /\blinked[-\s]?in\b/, profileKey: 'linkedin', allowedTypes: ['url', 'text'], confidence: 0.95 },
  { pattern: /\bgithub\b/, profileKey: 'github', allowedTypes: ['url', 'text'], confidence: 0.95 },
  { pattern: /\b(?:portfolio|case\s*study)\b/, profileKey: 'portfolio', allowedTypes: ['url', 'text'], confidence: 0.85 },
  { pattern: /\b(?:website|personal\s*site|blog|homepage)\b/, profileKey: 'website', allowedTypes: ['url', 'text'], confidence: 0.8 },
  // Name fields — order matters: first/last more specific than full name.
  { pattern: /\b(?:first\s*name|given\s*name|forename)\b/, profileKey: 'firstName', allowedTypes: ['text'], confidence: 0.95 },
  { pattern: /\b(?:last\s*name|surname|family\s*name)\b/, profileKey: 'lastName', allowedTypes: ['text'], confidence: 0.95 },
  { pattern: /\b(?:full\s*name|preferred\s*name|legal\s*name|name)\b/, profileKey: 'fullName', allowedTypes: ['text'], confidence: 0.8 },
  // Location
  { pattern: /\bcity\b/, profileKey: 'city', allowedTypes: ['text'], confidence: 0.9 },
  { pattern: /\b(?:state|province|region)\b/, profileKey: 'state', allowedTypes: ['text'], confidence: 0.85 },
  { pattern: /\bcountry\b/, profileKey: 'country', allowedTypes: ['text', 'select'], confidence: 0.85 },
  // Work authorization — note: we propose, the user always reviews.
  { pattern: /\b(?:work\s*auth|authorized\s*to\s*work|right\s*to\s*work|visa)\b/, profileKey: 'workAuthorization', allowedTypes: ['text', 'select', 'textarea'], confidence: 0.6 },
  { pattern: /\b(?:require[ds]?\s*sponsor(?:ship)?|need\s*sponsor(?:ship)?|sponsorship)\b/, profileKey: 'needsSponsorship', allowedTypes: ['select', 'radio'], confidence: 0.6 },
];

/** Build a FillPlan from the detected fields + the user's profile. */
export function planLocalFill(fields: DetectedField[], profile: UserProfile): FillPlan {
  const fills: FillInstruction[] = [];
  const unmatched: DetectedField[] = [];
  // EXT_SEC1 (round-15): collect sensitive fields into a dedicated
  // bucket so they're visible to callers (popup may want to show the
  // count) but never reach the cloud-fill payload.
  const skippedSensitive: DetectedField[] = [];

  for (const field of fields) {
    // Files can't be locally filled. Hand off to user.
    if (field.type === 'file') {
      unmatched.push(field);
      continue;
    }

    const haystack = [field.label, field.placeholder ?? '', extractName(field.selector)]
      .join(' ')
      .toLowerCase();

    // EXT_SEC1 (round-15): sensitivity check is the very first thing
    // we do after building the haystack. A field that looks like
    // "Date of Birth", "Race / Ethnicity", "SSN", etc. never even
    // reaches the regex match loop — neither the local mapper nor the
    // cloud filler is allowed to touch it. The user fills these
    // themselves.
    if (isSensitiveLabel(haystack)) {
      skippedSensitive.push(field);
      continue;
    }

    let matched: Rule | null = null;
    for (const rule of RULES) {
      if (!rule.pattern.test(haystack)) continue;
      if (rule.allowedTypes && !rule.allowedTypes.includes(field.type)) continue;
      matched = rule;
      break;
    }

    if (!matched) {
      unmatched.push(field);
      continue;
    }

    const value = profile[matched.profileKey];
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      // Rule matched but profile is empty — still leave it for the user
      // rather than overwriting with a blank.
      unmatched.push(field);
      continue;
    }

    fills.push({
      selector: field.selector,
      profileKey: matched.profileKey,
      value: String(value),
      type: field.type,
      confidence: matched.confidence,
    });
  }

  return { fills, unmatched, skippedSensitive };
}

function extractName(selector: string): string {
  // Selectors like `input[name="first_name"]` — pull the name attr out so
  // the mapper still hits on JD pages where the label is missing.
  const m = /name=(?:"([^"]+)"|'([^']+)')/.exec(selector);
  return m ? (m[1] ?? m[2] ?? '') : selector;
}
