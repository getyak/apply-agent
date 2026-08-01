import { Marked } from "marked";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeArtifactHref(href: string): string | null {
  try {
    const url = new URL(href);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol)
      ? href
      : null;
  } catch {
    return null;
  }
}

/**
 * Convert canonical résumé Markdown into passive HTML shared by the PDF and
 * DOCX renderers. Raw HTML is displayed as text, remote images are reduced to
 * alt text, and only explicit recruiter-safe link schemes survive.
 */
export function markdownToSafeArtifactHtml(markdown: string): string {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const safeHref = safeArtifactHref(href);
        if (!safeHref) return label;
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(safeHref)}"${titleAttribute}>${label}</a>`;
      },
      image({ text }) {
        return text
          ? `<span class="artifact-image-alt">${escapeHtml(text)}</span>`
          : "";
      },
    },
  });
  return marked.parse(markdown, { async: false }) as string;
}
