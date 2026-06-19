// ATS detection + form-field extraction.
//
// Caller: content.ts injects this on every Greenhouse / Lever / Ashby page
// (host_permissions list in manifest.json).
//
// The detector has two jobs:
//   1) classify the page (which ATS, what application id) so the backend's
//      jobmatch_agent.parse_jd_from_url knows how to fetch the JD;
//   2) walk the DOM and emit a normalised list of input fields the agent
//      can later fill (Task T6) or hand to /api/extension/map-fields (T7).
//
// We intentionally don't use selectors specific to one ATS's templated HTML —
// every ATS keeps changing markup. Instead we look at semantic signals:
// <label for=…>, aria-label, placeholder, input type. That makes the
// detector survive minor UI revisions.

export type ATSSource = 'greenhouse' | 'lever' | 'ashby' | 'other';

export interface ATSContext {
  source: ATSSource;
  /** ATS-native id (e.g. greenhouse job id, lever posting id). Null if unrecoverable. */
  externalId: string | null;
  /** Company slug from the URL (e.g. `synthetic` in jobs.lever.co/synthetic/...). */
  companySlug: string | null;
  /** The JD URL the backend should fetch — same as page URL by default. */
  jdUrl: string;
}

export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'date'
  | 'other';

export interface DetectedField {
  /** Stable id for the agent to reference back (DOM id, else generated). */
  id: string;
  /** Human-visible label (label[for], aria-label, placeholder, fallback). */
  label: string;
  type: FieldType;
  required: boolean;
  placeholder: string | null;
  /** For select/radio fields: the visible option labels. */
  options: string[];
  /** Selector the filler will use later (Task T6). */
  selector: string;
}

const GH_HOST = /^(?:job-)?boards(?:-api)?\.greenhouse\.io$/i;
const LEVER_HOST = /^jobs\.lever\.co$/i;
const ASHBY_HOST = /^jobs\.ashbyhq\.com$/i;

export function detectATS(url: string = window.location.href): ATSContext {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { source: 'other', externalId: null, companySlug: null, jdUrl: url };
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);

  if (GH_HOST.test(host)) {
    // https://boards.greenhouse.io/{company}/jobs/{id}
    const [companySlug = null, , externalId = null] = parts;
    return {
      source: 'greenhouse',
      externalId,
      companySlug,
      jdUrl: url,
    };
  }
  if (LEVER_HOST.test(host)) {
    // https://jobs.lever.co/{company}/{id}[/apply]
    const [companySlug = null, externalId = null] = parts;
    return { source: 'lever', externalId, companySlug, jdUrl: url };
  }
  if (ASHBY_HOST.test(host)) {
    // https://jobs.ashbyhq.com/{company}/{uuid}
    const [companySlug = null, externalId = null] = parts;
    return { source: 'ashby', externalId, companySlug, jdUrl: url };
  }
  return { source: 'other', externalId: null, companySlug: null, jdUrl: url };
}

/**
 * Walk the current document and return a normalised list of fillable form
 * fields. Filters out hidden / disabled inputs and obvious anti-bot fields
 * (honeypots: hidden + a name like "url" / "website" — common pattern).
 */
export function detectFields(doc: Document = document): DetectedField[] {
  const out: DetectedField[] = [];
  let counter = 0;

  // Scan inputs/textareas/selects across the page. NodeList → array for
  // type-narrowing.
  const elements = Array.from(
    doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    ),
  );

  for (const el of elements) {
    if (isHidden(el)) continue;
    if (el.disabled) continue;
    if (el instanceof HTMLInputElement) {
      // Skip submit / button-type inputs.
      if (['submit', 'button', 'hidden', 'reset', 'image'].includes(el.type)) continue;
      // Common honeypot heuristic: an input the page hides but expects empty.
      if (isHoneypot(el)) continue;
    }

    const id = stableId(el, counter++);
    const label = labelFor(el);
    const fieldType = mapFieldType(el);
    const options =
      el instanceof HTMLSelectElement
        ? Array.from(el.options)
            .filter((o) => !o.disabled && o.value !== '')
            .map((o) => o.textContent?.trim() ?? '')
            .filter(Boolean)
        : el instanceof HTMLInputElement && el.type === 'radio'
          ? gatherRadioOptions(el, doc)
          : [];

    out.push({
      id,
      label,
      type: fieldType,
      required: el.required,
      placeholder:
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.placeholder || null
          : null,
      options,
      selector: cssSelectorFor(el),
    });
  }

  return out;
}

function isHidden(el: HTMLElement): boolean {
  if (el.hidden) return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return false;
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}

function isHoneypot(el: HTMLInputElement): boolean {
  // Plain heuristic: input is positioned absurdly off-screen or width/height
  // collapsed by CSS, with a name that smells like a honeypot. We only skip
  // when both signals fire — false positives are worse than false negatives.
  const rect = el.getBoundingClientRect();
  const tiny = rect.width <= 2 || rect.height <= 2;
  const suspicious = /^(url|website|homepage|botcheck)$/i.test(el.name);
  return tiny && suspicious;
}

function stableId(el: Element, counter: number): string {
  if (el.id) return el.id;
  const name = (el as HTMLInputElement).name;
  if (name) return `vantage-field-${name}-${counter}`;
  return `vantage-field-${counter}`;
}

function labelFor(el: HTMLElement): string {
  if (el.id) {
    const lbl = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(el.id)}"]`);
    if (lbl?.textContent) return lbl.textContent.trim();
  }
  // Wrapped <label><input>…</label>
  const ancestorLabel = el.closest('label');
  if (ancestorLabel?.textContent) {
    return ancestorLabel.textContent.trim();
  }
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder.trim();
  }
  // Lever-style: label sits in a previous sibling div with className containing "label".
  let prev = el.previousElementSibling;
  while (prev) {
    if (/label/i.test(prev.className) && prev.textContent) {
      return prev.textContent.trim();
    }
    prev = prev.previousElementSibling;
  }
  return el.getAttribute('name') ?? '(unlabeled)';
}

function mapFieldType(el: HTMLElement): FieldType {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'email':
        return 'email';
      case 'tel':
        return 'tel';
      case 'url':
        return 'url';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'file':
        return 'file';
      case 'date':
        return 'date';
      case 'text':
      case 'search':
        return 'text';
      default:
        return 'other';
    }
  }
  return 'other';
}

function gatherRadioOptions(radio: HTMLInputElement, doc: Document): string[] {
  if (!radio.name) return [];
  const peers = doc.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${cssEscape(radio.name)}"]`,
  );
  const opts: string[] = [];
  for (const peer of Array.from(peers)) {
    opts.push(labelFor(peer));
  }
  return opts;
}

function cssSelectorFor(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const name = (el as HTMLInputElement).name;
  if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  // Last resort: positional path. Not stable across SPA re-renders but good
  // enough for a single popup display roundtrip.
  return el.tagName.toLowerCase();
}

function cssEscape(input: string): string {
  // Minimal CSS.escape polyfill for the chars we actually emit in form names.
  // Browsers have window.CSS.escape but content scripts inherit page CSP and
  // sometimes lack it (Firefox-only edge), so handle defensively.
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(input);
  }
  return input.replace(/(["\\\]])/g, '\\$1');
}
