// MarkdownMessage — Markdown renderer for assistant bubbles in the Ask
// Vantage dock and Resume Studio vibe chat (docs/architecture/vantage-ui-mapping.md
// §1, §2.6).
//
// Why a custom wrapper instead of <ReactMarkdown> raw: we want every
// element to inherit Vantage's palette (--color-brown, --color-cream,
// etc. — declared in app/globals.css), Inter / monospace stacks, and the
// existing 13.5px body size. Doing that via Tailwind alone would scatter
// chat-specific overrides across the chat surfaces; doing it here keeps
// the chat look in one file.
//
// Streaming-friendly: this component renders whatever string it gets, so
// the dock can rewrite the bubble on every SSE delta. The only tricky
// case — an unclosed ``` fence mid-stream — is patched by
// `balanceFences()` so react-markdown sees a syntactically valid block
// instead of dumping the half-arrived code as prose.
//
// User input is rendered as plain text upstream; this component is for
// assistant content only, so we don't have to worry about asterisks /
// brackets in user prose being eaten by Markdown.

"use client";

import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import "./markdown.css";

interface MarkdownMessageProps {
  content: string;
  // When true, the bubble keeps the dock's body text style. When false
  // (e.g. inside a tight result-card subline) we drop a bit of leading
  // and use the muted ink colour.
  variant?: "body" | "subline";
}

// If the assistant is mid-stream and a code fence has opened but not
// closed, append a synthetic closing fence so rehype-highlight still gets
// a balanced block. Otherwise react-markdown renders the half-arrived
// code as a giant paragraph until the closing ``` lands, which causes a
// noticeable visual flash. We don't strip the synthetic fence back out —
// it's invisible to the user and gets replaced as soon as the real one
// arrives in the next delta.
function balanceFences(src: string): string {
  const fences = src.match(/```/g);
  if (!fences) return src;
  if (fences.length % 2 === 0) return src;
  // Trailing newline so the fence is on its own line — required by
  // CommonMark for a valid closing fence.
  return src.endsWith("\n") ? `${src}\`\`\`` : `${src}\n\`\`\``;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {
        /* ignore — most likely a permissions error on insecure origins */
      });
  }, [text]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={onCopy}
      className="vt-md-code-copy"
      aria-label={copied ? "Copied" : "Copy code"}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}

// react-markdown gives <code> two shapes: inline (`foo`) and block
// (inside <pre>). We split them so inline code stays compact and block
// code gets the language label + copy chrome.
type CodeProps = ComponentProps<"code"> & { inline?: boolean };

function CodeBlock({ inline, className, children, ...rest }: CodeProps) {
  if (inline) {
    return (
      <code className="vt-md-inline-code" {...rest}>
        {children}
      </code>
    );
  }

  // Language hint from rehype-highlight, e.g. "language-ts hljs". Strip
  // hljs and trailing space; what remains after "language-" is the label
  // we surface to the user.
  const langMatch = /language-([\w+-]+)/.exec(className ?? "");
  const lang = langMatch?.[1] ?? "code";

  // children can be a string (single-line) or an array (multi-line) —
  // join to a string for the copy buffer regardless.
  const raw = Array.isArray(children) ? children.join("") : String(children ?? "");

  return (
    <div className="vt-md-code-wrap">
      <div className="vt-md-code-toolbar">
        <span className="vt-md-code-lang">{lang}</span>
        <CopyButton text={raw.replace(/\n$/, "")} />
      </div>
      <pre className="vt-md-pre">
        <code className={className} {...rest}>
          {children}
        </code>
      </pre>
    </div>
  );
}

export function MarkdownMessage({ content, variant = "body" }: MarkdownMessageProps) {
  const safe = balanceFences(content);

  return (
    <div className={variant === "subline" ? "vt-md vt-md-subline" : "vt-md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          p: ({ children }) => <p className="vt-md-p">{children}</p>,
          h1: ({ children }) => <h3 className="vt-md-h1">{children}</h3>,
          h2: ({ children }) => <h4 className="vt-md-h2">{children}</h4>,
          h3: ({ children }) => <h5 className="vt-md-h3">{children}</h5>,
          ul: ({ children }) => <ul className="vt-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="vt-md-ol">{children}</ol>,
          li: ({ children }) => <li className="vt-md-li">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="vt-md-blockquote">{children}</blockquote>
          ),
          a: ({ children, href }) => (
            <a
              className="vt-md-a"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="vt-md-table-wrap">
              <table className="vt-md-table">{children}</table>
            </div>
          ),
          hr: () => <hr className="vt-md-hr" />,
          code: CodeBlock,
        }}
      >
        {safe}
      </ReactMarkdown>
    </div>
  );
}
