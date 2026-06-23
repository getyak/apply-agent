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

import {
  isValidElement,
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
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

// react-markdown v10 no longer passes an `inline` prop to the `code`
// component (breaking change from v9). It instead renders block code as
// <pre><code> and inline code as a bare <code>. So the `code` component
// must ALWAYS return phrasing content (a plain <code>) — returning a
// <div>/<pre> here is what produced "<div> cannot be a descendant of <p>"
// (react-markdown can place an inline <code> inside a <p>; a <div> there
// is invalid HTML and breaks hydration).
//
// The language label + copy chrome therefore live on the `pre` component
// below, which is only ever emitted for block code and is never nested in
// a <p>.
type CodeProps = ComponentProps<"code">;

function InlineOrBlockCode({ className, children, ...rest }: CodeProps) {
  // Block code carries a `language-*` class from rehype-highlight; inline
  // code has none. Either way we only emit a <code> here.
  const isBlock = /\blanguage-/.test(className ?? "");
  return (
    <code className={isBlock ? className : "vt-md-inline-code"} {...rest}>
      {children}
    </code>
  );
}

// Block-code chrome. `pre` is block-level and never lands inside a <p>, so
// the wrapping <div> + toolbar are safe here. We read the language label and
// copy buffer off the child <code> element's props.
function PreBlock({ children }: ComponentProps<"pre">) {
  const child = Array.isArray(children) ? children[0] : children;
  let lang = "code";
  let raw = "";
  if (isValidElement(child)) {
    const props = child.props as { className?: string; children?: ReactNode };
    const langMatch = /language-([\w+-]+)/.exec(props.className ?? "");
    if (langMatch) lang = langMatch[1];
    const inner = props.children;
    raw = Array.isArray(inner) ? inner.join("") : String(inner ?? "");
  }

  return (
    <div className="vt-md-code-wrap">
      <div className="vt-md-code-toolbar">
        <span className="vt-md-code-lang">{lang}</span>
        <CopyButton text={raw.replace(/\n$/, "")} />
      </div>
      <pre className="vt-md-pre">{children}</pre>
    </div>
  );
}

export function MarkdownMessage({ content, variant = "body" }: MarkdownMessageProps) {
  const safe = balanceFences(content);

  return (
    <div className={variant === "subline" ? "vt-md vt-md-subline" : "vt-md"}>
      <ReactMarkdown
        // MD1 (round-11): the round-11 markdown audit pointed out that
        // we were rendering assistant + résumé text through ReactMarkdown
        // with no HTML guard, so an LLM-emitted `<img onerror=...>` or
        // `<script>` would actually evaluate. `skipHtml` stops every raw
        // HTML fragment at parse time — react-markdown drops the tags
        // and only emits its own Markdown→React tree. We deliberately
        // don't pull in rehype-sanitize because we never need *any* raw
        // HTML in our chat surfaces; this is the simpler, dependency-
        // free posture (round-12 will revisit if the product ever wants
        // sanitized inline HTML, e.g. for embed cards).
        skipHtml={true}
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
              // MD3 (round-11): href came straight out of the LLM /
              // user text. `safeHref` strips `javascript:`, `data:`,
              // `vbscript:`, and other actively-dangerous schemes —
              // anything that survives becomes a regular http(s) link
              // that the existing rel="noopener noreferrer" already
              // sandboxes. A rejected href becomes undefined so React
              // omits the attribute entirely (the text still renders).
              href={safeHref(href)}
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
          code: InlineOrBlockCode,
          pre: PreBlock,
        }}
      >
        {safe}
      </ReactMarkdown>
    </div>
  );
}

// MD3 (round-11): a tiny scheme allow-list. We deliberately don't
// import a URL library — the input here is either a relative path, a
// real http(s) URL, or a `mailto:` / `tel:` link. Anything else (most
// importantly `javascript:` / `data:` / `vbscript:` / `file:`) gets
// dropped. We strip whitespace/control chars before comparing the
// scheme so `j\tavascript:` and `\njavascript:` can't slip past.
export function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  // Relative paths and fragment links — always safe.
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("?")
  )
    return trimmed;
  // Collapse any embedded whitespace / control chars before sniffing
  // the scheme. \s in a JS regex covers space, tab, newline, CR, and
  // form-feed — exactly the characters used to obfuscate the colon.
  const collapsed = trimmed.replace(/\s+/g, "");
  const lower = collapsed.toLowerCase();
  if (
    lower.startsWith("http:") ||
    lower.startsWith("https:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:")
  ) {
    // Keep the user's original casing/spacing on accepted hrefs.
    return trimmed;
  }
  return undefined;
}
