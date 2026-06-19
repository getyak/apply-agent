// Cloud field filler — POSTs leftover fields to /api/extension/map-fields
// where AppPrepAgent.generate_form_answers takes over.
//
// Skeleton landed in T6 so content.ts compiles; the real backend call is
// finished in T7. Calling with useCloud=false from content.ts means this
// module's network path is never exercised yet.

import type { DetectedField, ATSContext } from './ats-detect.js';
import type { FillInstruction } from './local-fill.js';

export interface CloudFillRequest {
  context: ATSContext;
  jdUrl: string;
  fields: DetectedField[];
}

export interface CloudFillResponse {
  fills: FillInstruction[];
  unmatched: DetectedField[];
}

const DEFAULT_BACKEND = 'http://localhost:8081';

export async function fetchCloudFills(req: CloudFillRequest): Promise<CloudFillResponse | null> {
  const backend = await resolveBackend();
  try {
    const resp = await fetch(`${backend}/extension/map-fields`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Partial<CloudFillResponse>;
    return {
      fills: Array.isArray(data.fills) ? data.fills : [],
      unmatched: Array.isArray(data.unmatched) ? data.unmatched : req.fields,
    };
  } catch {
    return null;
  }
}

async function resolveBackend(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['backendUrl'], (items) => {
      const stored = typeof items.backendUrl === 'string' ? items.backendUrl : null;
      resolve(stored || DEFAULT_BACKEND);
    });
  });
}
