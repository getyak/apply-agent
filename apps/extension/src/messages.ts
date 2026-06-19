// Inter-script messages.
//
// content.ts ⇄ background.ts ⇄ popup.ts all speak through chrome.runtime
// message-passing. Defining the wire format in one place keeps the
// handlers honest — TypeScript narrows on the discriminated `type`.

import type { ATSContext, DetectedField } from './ats-detect.js';

export interface DetectionPayload {
  context: ATSContext;
  fields: DetectedField[];
  detectedAt: number; // epoch ms
  /** URL of the tab the snapshot came from (origin + path; no query for privacy). */
  pageUrl: string;
}

export interface FillSummary {
  filledLocal: number;
  filledCloud: number;
  skippedSensitive: number;
  unmatched: number;
  errors: number;
  /** Detected fields the user still needs to review/fill themselves. */
  remaining: DetectedField[];
}

export type Message =
  | { type: 'content/detection'; payload: DetectionPayload }
  | { type: 'popup/request-snapshot' }
  | { type: 'background/snapshot'; payload: DetectionPayload | null }
  | { type: 'popup/handshake-check' }
  | { type: 'background/handshake-result'; ok: boolean; backendUrl: string }
  // Fill flow (T6 + T7)
  | { type: 'popup/fill-request'; useCloud: boolean }
  | { type: 'content/fill-result'; summary: FillSummary };
