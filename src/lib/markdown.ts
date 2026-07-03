import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

// Code blocks: syntax highlighting + a copy button. The button is handled by
// event delegation (handleMarkdownClick) since we render HTML strings.
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  let highlighted: string;
  let cls = "hljs";
  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(text, { language: lang }).value;
      cls += " language-" + lang;
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }
  } catch {
    highlighted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  const label = lang || "";
  return `<div class="codewrap"><div class="codebar"><span class="codelang">${label}</span><button class="code-copy" type="button" title="Copy code">⧉ Copy</button></div><pre><code class="${cls}">${highlighted}</code></pre></div>`;
};

marked.setOptions({ gfm: true, breaks: true, renderer });

// Force all links to open externally via the OS browser.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed"],
  });
}

/** Delegated click handler for rendered markdown (attach to the .md container). */
export function handleMarkdownClick(e: React.MouseEvent<HTMLElement>) {
  const btn = (e.target as HTMLElement).closest?.(".code-copy");
  if (!btn) return;
  const code = btn.closest(".codewrap")?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code);
  btn.textContent = "✓ Copied";
  window.setTimeout(() => (btn.textContent = "⧉ Copy"), 1500);
}

/** Strip markdown to plain text (for TTS, previews, exports). */
export function markdownToText(md: string): string {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(md);
  return (div.textContent || "").trim();
}
