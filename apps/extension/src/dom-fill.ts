// DOM fill — apply FillInstructions to the actual page.
//
// Why this module exists separately from local-fill: planning is pure data
// (testable, no DOM); applying is side-effecty (touches React's synthetic
// input state via the descriptor trick).
//
// Caller: content.ts, after planLocalFill / cloud /map-fields response.

import type { FillInstruction } from './local-fill.js';

export interface ApplyOptions {
  /** Delay between fills, ms (sampled uniformly in this range). */
  minGapMs?: number;
  maxGapMs?: number;
}

export interface ApplyResult {
  filled: number;
  skipped: number;
  errors: Array<{ selector: string; reason: string }>;
}

const HIGHLIGHT_CLASS = 'vantage-filled';
const HIGHLIGHT_STYLE_ID = 'vantage-fill-style';

/** Sequentially apply each instruction with a humanish gap. */
export async function applyFills(
  instructions: FillInstruction[],
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  injectHighlightStyle();
  const minGap = opts.minGapMs ?? 50;
  const maxGap = opts.maxGapMs ?? 200;
  const result: ApplyResult = { filled: 0, skipped: 0, errors: [] };

  for (const inst of instructions) {
    const el = document.querySelector(inst.selector);
    if (!el) {
      result.errors.push({ selector: inst.selector, reason: 'not_found' });
      continue;
    }

    try {
      const wrote = writeValue(el as HTMLElement, inst.value, inst.type);
      if (wrote) {
        markFilled(el as HTMLElement, inst);
        result.filled += 1;
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      result.errors.push({ selector: inst.selector, reason: String((err as Error).message) });
    }

    await sleep(randBetween(minGap, maxGap));
  }

  return result;
}

function writeValue(el: HTMLElement, value: string, type: FillInstruction['type']): boolean {
  if (el instanceof HTMLSelectElement) {
    const target = Array.from(el.options).find(
      (o) => o.value === value || (o.textContent ?? '').trim() === value,
    );
    if (!target) return false;
    target.selected = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio')) {
    // For yes/no profile values; we don't currently fill these locally except
    // for radio yes/no toggles. Skip if non-trivial.
    const shouldCheck = /^(yes|true|1|on)$/i.test(value);
    el.checked = shouldCheck;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // React tracks the previous value on the input's prototype descriptor;
    // setting `.value` directly is invisible to React. Use the prototype
    // setter to make the change visible to controlled components.
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

function markFilled(el: HTMLElement, inst: FillInstruction): void {
  el.classList.add(HIGHLIGHT_CLASS);
  el.setAttribute('data-vantage-key', inst.profileKey);
  el.setAttribute('data-vantage-confidence', inst.confidence.toFixed(2));
}

function injectHighlightStyle(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      border-bottom: 2px dashed #fbbf24 !important;
      box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.25) inset;
      transition: box-shadow 240ms ease;
    }
    .${HIGHLIGHT_CLASS}:focus {
      box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.6) inset !important;
    }
  `;
  document.head.appendChild(style);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
