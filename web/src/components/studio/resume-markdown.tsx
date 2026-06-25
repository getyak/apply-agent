// ResumeMarkdown — printed-document renderer for the résumé optimized track
// (docs/design/resume-original-vs-optimized-vibe-design.md §11.2/§11.3).
//
// Goal: the user opens Resume Studio and sees their résumé rendered like a
// finished document — type that reads like printed paper, not a chat bubble.
// This is the 10/10 surface the design doc calls for.
//
// Implementation principles:
//   - react-markdown + remark-gfm: GFM is what the LLM produces. No raw HTML
//     (skipHtml=true) — same defensive posture as chat/markdown-message.tsx.
//   - One theme, every résumé: layout differences come from CONTENT, not
//     per-résumé templates. The CSS lives in ./resume-markdown.css.
//   - Bullet stable IDs surface as data attributes on each <li>, so a future
//     vibe-edit click handler can target a specific bullet without re-parsing.
//   - "AI-touched" overlay: each suggestion's after_text wraps its bullet in
//     a coloured highlight (gold = safe, coral = needs_review). Pure
//     presentational; the accept/reject UI is owned by the dock + suggestion
//     panel, not this component.

"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeHref } from "../chat/markdown-message";
import "./resume-markdown.css";

export interface ResumeMarkdownSuggestion {
  /** Stable bullet id (resumes.bullet_index key). */
  bullet_stable_id?: string | null;
  /** The new text we'd swap into the bullet. */
  after_text: string;
  /** The bullet text we'd replace. Used to match a line when stable id is missing. */
  before_text?: string | null;
  /** safe | needs_review | unsupported — drives the highlight palette. */
  risk_level?: "safe" | "needs_review" | "unsupported" | string | null;
}

interface ResumeMarkdownProps {
  /** Canonical GFM markdown produced by api/src/resume-markdown.ts. */
  markdown: string;
  /** Proposed suggestions to overlay onto matching bullet lines. Optional. */
  suggestions?: ResumeMarkdownSuggestion[];
  /** Called when a bullet line is clicked (vibe edit entry, optional). */
  onBulletClick?: (lineText: string) => void;
  /** Show the AI overlay? Defaults true; the Original tab passes false. */
  showAIOverlay?: boolean;
}

export function ResumeMarkdown({
  markdown,
  suggestions,
  onBulletClick,
  showAIOverlay = true,
}: ResumeMarkdownProps) {
  // Build a quick map: bullet text → suggestion (for the overlay). We match
  // by EXACT trimmed text — the markdown writer guarantees one highlight per
  // line, so a substring match would be over-eager.
  const overlay = useMemo(() => {
    const m = new Map<string, ResumeMarkdownSuggestion>();
    if (!showAIOverlay || !suggestions) return m;
    for (const s of suggestions) {
      const key = (s.before_text ?? "").trim();
      if (key) m.set(key, s);
    }
    return m;
  }, [suggestions, showAIOverlay]);

  return (
    <div className="resume-prose" data-testid="resume-prose">
      <ReactMarkdown
        // Mirror the chat surface's posture: no raw HTML ever. The LLM emits
        // markdown; if a malicious snippet ever lands here it gets dropped.
        skipHtml={true}
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={safeHref(href)} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          li: ({ children }) => {
            const text = liTextOf(children);
            const hit = overlay.get(text);
            const handle = onBulletClick
              ? () => onBulletClick(text)
              : undefined;
            const cls = hit
              ? hit.risk_level === "safe"
                ? "rp-touched"
                : "rp-touched rp-touched-review"
              : undefined;
            return (
              <li
                data-bullet-id={hit?.bullet_stable_id ?? undefined}
                data-bullet-risk={hit?.risk_level ?? undefined}
                onClick={handle}
                style={handle ? { cursor: "pointer" } : undefined}
              >
                {cls ? <span className={cls}>{children}</span> : children}
              </li>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/** Flatten a react-markdown LI's children into its raw text (best-effort).
 * Used to match an LI against the suggestion overlay map. */
function liTextOf(children: unknown): string {
  if (typeof children === "string") return children.trim();
  if (Array.isArray(children)) {
    return children.map(liTextOf).join("").trim();
  }
  if (children && typeof children === "object") {
    const rec = children as { props?: { children?: unknown } };
    if (rec.props && "children" in rec.props) {
      return liTextOf(rec.props.children);
    }
  }
  return "";
}
