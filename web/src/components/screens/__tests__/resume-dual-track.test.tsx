// Component test for <ResumeDualTrack>. The web package intentionally avoids a
// DOM test lib (see web/src/lib/use-resume-edit.test.ts) — we render the
// component to static markup via react-dom/server and assert on the structure
// + accessibility contract. Handler wiring (onSelect/onDecide) is verified by
// walking the rendered React element tree and invoking the onClick closures,
// which mirrors a real click without a DOM.

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import {
  ResumeDualTrack,
  SuggestionStack,
  TrackColumn,
  type DualTrackSuggestion,
  type DualTrackVersion,
} from "../resume-dual-track";
import en from "../../../../messages/en.json";

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en as never}>
      {node}
    </NextIntlClientProvider>,
  );
}

// Identity translator for directly unit-testing the hook-free sub-components
// (TrackColumn / SuggestionStack take `t` as a prop). Returns the key so the
// interaction tests don't depend on message copy.
const idT = (key: string) => key;

// Walk a React element (no function-component invocation — that would trip
// the Rules of Hooks) collecting nodes whose props match `pred`, so we can
// grab a button and fire its onClick closure without a DOM.
function findAll(
  node: ReactNode,
  pred: (props: Record<string, unknown>) => boolean,
  acc: ReactElement[] = [],
): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, acc);
    return acc;
  }
  if (!isValidElement(node)) return acc;
  const el = node as ReactElement<Record<string, unknown>>;
  const props = (el.props ?? {}) as Record<string, unknown>;
  if (pred(props)) acc.push(el);
  if (props.children != null) findAll(props.children as ReactNode, pred, acc);
  return acc;
}

const originals: DualTrackVersion[] = [
  { id: "o1", version: 2, track: "original", derivedFrom: null, createdAt: "2026-06-15T00:00:00Z" },
  { id: "o0", version: 1, track: "original", derivedFrom: null, createdAt: "2026-06-01T00:00:00Z" },
];
const optimized: DualTrackVersion[] = [
  { id: "op1", version: 3, track: "optimized", derivedFrom: "o1", createdAt: "2026-06-15T01:00:00Z" },
];
const tailored: DualTrackVersion[] = [
  { id: "t1", version: 5, track: "tailored", derivedFrom: "op1", createdAt: "2026-06-16T00:00:00Z" },
];

const suggestions: DualTrackSuggestion[] = [
  {
    id: "s1",
    bullet_stable_id: "b_abc",
    section: "work",
    change_type: "quantify_existing",
    before_text: "Worked on migration",
    after_text: "Led migration of monolith to 4 services",
    rationale: "actives + quantify",
    risk_level: "needs_review",
    status: "proposed",
    proposed_by: "optimize_general",
  },
];

const base = {
  originals,
  optimized,
  tailored,
  selectedId: "o1" as string | null,
  onSelect: () => {},
  suggestions,
  onDecide: () => {},
};

describe("ResumeDualTrack", () => {
  it("renders three track columns", () => {
    const html = render(<ResumeDualTrack {...base} />);
    expect(html).toContain('data-track="original"');
    expect(html).toContain('data-track="optimized"');
    expect(html).toContain('data-track="tailored"');
  });

  it("labels the region and column list for screen readers", () => {
    const html = render(<ResumeDualTrack {...base} />);
    expect(html).toContain('aria-label="Résumé dual-track view"');
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-label="Résumé tracks: original, optimized, tailored"');
    expect(html).toContain('aria-label="Original track — your immutable uploads"');
  });

  it("marks the original track immutable (mirrors prevent_original_mutation)", () => {
    const html = render(<ResumeDualTrack {...base} />);
    expect(html).toContain("Immutable");
    expect(html).toContain('data-testid="immutable-badge"');
  });

  it("marks the selected version with aria-current", () => {
    const html = render(<ResumeDualTrack {...base} />);
    // Attribute order isn't guaranteed; assert both attrs co-occur on the same
    // <button> element (a single tag has no '>' until it closes).
    expect(html).toMatch(
      /<button[^>]*aria-current="true"[^>]*data-testid="track-row-original-2"/,
    );
    // A non-selected row's button must not carry aria-current.
    expect(html).not.toMatch(
      /<button[^>]*data-testid="track-row-optimized-3"[^>]*aria-current="true"/,
    );
  });

  it("renders a row per version across tracks", () => {
    const html = render(<ResumeDualTrack {...base} />);
    expect(html).toContain('data-testid="track-row-original-2"');
    expect(html).toContain('data-testid="track-row-original-1"');
    expect(html).toContain('data-testid="track-row-optimized-3"');
    expect(html).toContain('data-testid="track-row-tailored-5"');
  });

  it("renders the suggestion stack with accept + reject controls", () => {
    const html = render(<ResumeDualTrack {...base} />);
    expect(html).toContain('data-testid="suggestion-stack"');
    expect(html).toContain('role="region"');
    expect(html).toContain('data-testid="accept-s1"');
    expect(html).toContain('data-testid="reject-s1"');
    expect(html).toContain('aria-label="Accept suggestion: quantify_existing"');
    expect(html).toContain('aria-label="Reject suggestion: quantify_existing"');
  });

  it("shows the before/after diff and needs_review risk badge", () => {
    const html = render(<ResumeDualTrack {...base} />);
    expect(html).toContain("Worked on migration");
    expect(html).toContain("Led migration of monolith to 4 services");
    expect(html).toContain('data-testid="risk-s1"');
    expect(html).toContain("Needs review");
  });

  it("hides the suggestion stack when there are none", () => {
    const html = render(<ResumeDualTrack {...base} suggestions={[]} />);
    expect(html).not.toContain('data-testid="suggestion-stack"');
  });

  it("renders an empty-state row for a track with no versions", () => {
    const html = render(<ResumeDualTrack {...base} tailored={[]} />);
    expect(html).toContain("None yet");
  });

  it("fires onSelect with the row's id when a track row is clicked", () => {
    const selects: string[] = [];
    // TrackColumn is hook-free (t is a prop) — invoke it directly and walk the
    // returned element tree for the row button.
    const tree = TrackColumn({
      t: idT,
      track: "optimized",
      rows: optimized,
      selectedId: "o1",
      onSelect: (id) => selects.push(id),
    });
    const buttons = findAll(
      tree,
      (p) => p["data-testid"] === "track-row-optimized-3" && typeof p.onClick === "function",
    );
    expect(buttons.length).toBe(1);
    (buttons[0].props.onClick as () => void)();
    expect(selects).toEqual(["op1"]);
  });

  it("fires onDecide with (id, decision) for accept and reject", () => {
    const decisions: Array<[string, string]> = [];
    const tree = SuggestionStack({
      t: idT,
      suggestions,
      onDecide: (id, d) => decisions.push([id, d]),
    });
    const accept = findAll(
      tree,
      (p) => p["data-testid"] === "accept-s1" && typeof p.onClick === "function",
    );
    const reject = findAll(
      tree,
      (p) => p["data-testid"] === "reject-s1" && typeof p.onClick === "function",
    );
    expect(accept.length).toBe(1);
    expect(reject.length).toBe(1);
    (accept[0].props.onClick as () => void)();
    (reject[0].props.onClick as () => void)();
    expect(decisions).toEqual([
      ["s1", "accept"],
      ["s1", "reject"],
    ]);
  });
});
