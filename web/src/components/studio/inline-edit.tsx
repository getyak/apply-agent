// Inline edit atoms — click-to-edit primitives the Resume Studio Optimized
// pane is built from. Three flavours:
//
//   <InlineText/>      — single-line (basics, dates, links)
//   <InlineParagraph/> — multi-line, autoresizing (summary, role summary)
//   <InlineBullet/>    — one bullet in a list: click to edit, ⌘↵ saves,
//                        Esc cancels, Backspace on an empty bullet deletes,
//                        and adjacent bullets share a single "add" affordance.
//
// All three share the same model:
//   - `value`: source of truth from the parent's edit hook (state.draft).
//   - `onCommit(next)`: parent decides whether to call commit() — we never
//     reach into a store directly.
//   - `placeholder`: shown when value is empty; click still enters edit mode.
//   - `validate?`: optional sync fn; returns null on success or an error.
//     We don't block commit but we surface the message.
//
// Why no <input>/<textarea>: contentEditable on a span/div preserves the
// document's typographic flow (kerning, baseline, font) instead of plopping
// a form control with its own min-height into the middle of the résumé.
// Trade-off: we lose native browser spellcheck UX in some edge cases, so we
// wire `spellCheck` and `autoCapitalize="off"` explicitly.

"use client";

import {
  forwardRef,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

type CommonProps = {
  value: string | undefined;
  /** Called when the user commits (blur or ⌘↵). Skipped when the value is
   *  unchanged. The parent's commit() does its own no-op detection too. */
  onCommit: (next: string) => void;
  placeholder?: string;
  /** Validate the trimmed text. Return null when OK, a string when not. */
  validate?: (next: string) => string | null;
  /** Stops the click-to-edit affordance entirely. Used when a sibling
   *  suggestion is pending — see R-6 mutex rule. */
  disabled?: boolean;
  /** Visual ink — basics use ink-2, bullets use ink-1. */
  tone?: "primary" | "secondary";
  /** Test hook so Playwright can grab a specific node without guessing at
   *  internal class names. */
  "data-testid"?: string;
  /** Extra className for layout (alignment, max-width). */
  className?: string;
};

const baseStyle: React.CSSProperties = {
  outline: "none",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  cursor: "text",
  borderRadius: 4,
  padding: "2px 4px",
  margin: "-2px -4px",
  transition: "background 120ms ease",
};

const editingStyle: React.CSSProperties = {
  background: "rgba(212, 162, 65, 0.10)",
  boxShadow: "inset 0 0 0 1px rgba(212, 162, 65, 0.35)",
};

const errorStyle: React.CSSProperties = {
  boxShadow: "inset 0 0 0 1px rgba(162, 58, 46, 0.55)",
};

const placeholderStyle: React.CSSProperties = {
  color: "rgba(48, 38, 32, 0.42)",
  fontStyle: "italic",
};

function useInlineEditor({
  value,
  onCommit,
  validate,
  multiline,
}: {
  value: string | undefined;
  onCommit: (next: string) => void;
  validate?: (next: string) => string | null;
  multiline: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track the last value the user actually committed (or the last `value`
  // prop). Used by Esc to revert and by the no-op short-circuit.
  const lastCommittedRef = useRef<string>(value ?? "");
  useEffect(() => {
    lastCommittedRef.current = value ?? "";
  }, [value]);

  // Keep the live DOM contents in sync when the parent prop changes (e.g.
  // accept an AI suggestion → suggestion's after_text becomes our value).
  // We DON'T do this while editing — overwriting contentEditable kills the
  // caret position.
  useEffect(() => {
    if (editing) return;
    if (!ref.current) return;
    if (ref.current.textContent !== (value ?? "")) {
      ref.current.textContent = value ?? "";
    }
  }, [value, editing]);

  const commit = useCallback(() => {
    if (!ref.current) {
      setEditing(false);
      return;
    }
    const next = (ref.current.textContent ?? "").replace(/\s+$/u, "");
    if (next === lastCommittedRef.current) {
      setEditing(false);
      setError(null);
      return;
    }
    const v = validate?.(next) ?? null;
    setError(v);
    lastCommittedRef.current = next;
    onCommit(next);
    setEditing(false);
  }, [onCommit, validate]);

  const cancel = useCallback(() => {
    if (!ref.current) {
      setEditing(false);
      return;
    }
    ref.current.textContent = lastCommittedRef.current;
    setError(null);
    setEditing(false);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === "Enter") {
        // Single-line: Enter commits.
        // Multi-line: only ⌘↵ / Ctrl↵ commits; plain Enter inserts newline.
        if (!multiline || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          commit();
        }
      }
    },
    [commit, cancel, multiline],
  );

  return { ref, editing, setEditing, error, commit, cancel, onKeyDown };
}

export const InlineText = forwardRef<HTMLDivElement, CommonProps>(function InlineText(
  { value, onCommit, placeholder, validate, disabled, tone, className, ...rest },
  forwardedRef,
) {
  const id = useId();
  const { ref, editing, setEditing, error, onKeyDown, commit } = useInlineEditor({
    value,
    onCommit,
    validate,
    multiline: false,
  });
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [ref, forwardedRef],
  );
  const isEmpty = !(value ?? "").trim();
  return (
    <span style={{ display: "inline-block", minWidth: 4 }} className={className}>
      <div
        ref={setRefs}
        id={id}
        role="textbox"
        aria-label={placeholder ?? "Editable text"}
        aria-multiline="false"
        aria-invalid={error ? "true" : "false"}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        autoCapitalize="off"
        data-testid={rest["data-testid"]}
        onFocus={() => !disabled && setEditing(true)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        style={{
          ...baseStyle,
          ...(editing ? editingStyle : null),
          ...(error ? errorStyle : null),
          ...(isEmpty && !editing ? placeholderStyle : null),
          color:
            tone === "secondary"
              ? "rgba(48, 38, 32, 0.72)"
              : "rgba(48, 38, 32, 0.92)",
          minWidth: 8,
          display: "inline-block",
        }}
      >
        {isEmpty && !editing ? placeholder ?? "" : value ?? ""}
      </div>
      {error ? (
        <span
          role="alert"
          style={{
            display: "block",
            color: "#A23A2E",
            fontSize: 11,
            marginTop: 2,
            letterSpacing: 0.2,
          }}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
});

export function InlineParagraph(props: CommonProps) {
  const { value, onCommit, placeholder, validate, disabled, tone, className } = props;
  const { ref, editing, setEditing, error, onKeyDown, commit } = useInlineEditor({
    value,
    onCommit,
    validate,
    multiline: true,
  });
  const isEmpty = !(value ?? "").trim();
  return (
    <div className={className} style={{ minHeight: "1.4em" }}>
      <div
        ref={ref}
        role="textbox"
        aria-label={placeholder ?? "Editable paragraph"}
        aria-multiline="true"
        aria-invalid={error ? "true" : "false"}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        autoCapitalize="off"
        data-testid={props["data-testid"]}
        onFocus={() => !disabled && setEditing(true)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        style={{
          ...baseStyle,
          ...(editing ? editingStyle : null),
          ...(error ? errorStyle : null),
          ...(isEmpty && !editing ? placeholderStyle : null),
          color:
            tone === "secondary"
              ? "rgba(48, 38, 32, 0.72)"
              : "rgba(48, 38, 32, 0.92)",
          minHeight: "1.4em",
        }}
      >
        {isEmpty && !editing ? placeholder ?? "" : value ?? ""}
      </div>
      {error ? (
        <span
          role="alert"
          style={{
            display: "block",
            color: "#A23A2E",
            fontSize: 11,
            marginTop: 2,
          }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface InlineBulletProps extends CommonProps {
  /** Backspace on an empty bullet calls this, letting the parent remove the
   *  bullet from the list. No-op when disabled. */
  onDeleteEmpty?: () => void;
  /** R-6 mutex overlay: when a proposed AI suggestion targets this bullet,
   *  we show a hint label above the text so the user knows there's a pending
   *  change available in the dock. */
  pendingSuggestionHint?: string;
}

export function InlineBullet({
  value,
  onCommit,
  onDeleteEmpty,
  placeholder,
  validate,
  disabled,
  pendingSuggestionHint,
  className,
  ...rest
}: InlineBulletProps) {
  const { ref, editing, setEditing, error, onKeyDown, commit } = useInlineEditor({
    value,
    onCommit,
    validate,
    multiline: false,
  });
  const isEmpty = !(value ?? "").trim();
  // Hijack Backspace when the bullet is empty so the parent can delete it
  // (no value to type into; user intent is unambiguous).
  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Backspace" && isEmpty && onDeleteEmpty) {
        e.preventDefault();
        onDeleteEmpty();
        return;
      }
      onKeyDown(e);
    },
    [onKeyDown, isEmpty, onDeleteEmpty],
  );
  return (
    <li
      className={className}
      style={{
        listStyle: "none",
        margin: "0 0 6px 0",
        padding: 0,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        position: "relative",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          color: "rgba(212, 162, 65, 0.7)",
          marginTop: "0.45em",
          flex: "0 0 auto",
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        •
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {pendingSuggestionHint ? (
          <div
            style={{
              fontSize: 11,
              color: "rgba(212, 162, 65, 0.95)",
              letterSpacing: 0.4,
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            {pendingSuggestionHint}
          </div>
        ) : null}
        <div
          ref={ref}
          role="textbox"
          aria-label={placeholder ?? "Edit bullet"}
          aria-multiline="false"
          aria-invalid={error ? "true" : "false"}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          autoCapitalize="off"
          data-testid={rest["data-testid"]}
          onFocus={() => !disabled && setEditing(true)}
          onBlur={commit}
          onKeyDown={onKey}
          style={{
            ...baseStyle,
            ...(editing ? editingStyle : null),
            ...(error ? errorStyle : null),
            ...(isEmpty && !editing ? placeholderStyle : null),
            color: "rgba(48, 38, 32, 0.92)",
            lineHeight: 1.55,
          }}
        >
          {isEmpty && !editing ? placeholder ?? "Click to add a bullet…" : value ?? ""}
        </div>
        {error ? (
          <span role="alert" style={{ display: "block", color: "#A23A2E", fontSize: 11, marginTop: 2 }}>
            {error}
          </span>
        ) : null}
      </div>
    </li>
  );
}
