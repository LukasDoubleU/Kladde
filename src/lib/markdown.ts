// Markdown to sanitized HTML for the preview pane.
//
// - GitHub-flavoured: tables, strikethrough, task lists, autolinks, heading anchors (the slug rule is in links.ts,
//   which the editor uses to jump to the same headings).
// - Local images resolve relative to the Markdown file and load through Tauri's asset protocol.
// - Code blocks are highlighted with the same grammars as the editor.
// - Mermaid fences become placeholders that the preview draws (mermaid.ts); math is rendered by KaTeX (math.ts).
// - Block elements carry data-line attributes so the preview can follow the editor's scrolling.

import { LanguageDescription } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import MarkdownIt, { type StateCore } from "markdown-it";
import { allLanguages } from "./languages";
import { createSlugger, resolvePath } from "./links";
import { mathPlugin, renderMathFence } from "./math";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let onLanguageLoaded: (() => void) | null = null;

/** Called when a code block language finished loading, so the preview can re-render. */
export function setLanguageLoadedHandler(handler: () => void) {
  onLanguageLoaded = handler;
}

function highlight(code: string, lang: string): string {
  if (!lang) return "";
  const desc = LanguageDescription.matchLanguageName(allLanguages, lang.split(/\s/)[0], true);
  if (!desc) return "";
  if (!desc.support) {
    void desc.load().then(() => onLanguageLoaded?.());
    return "";
  }
  let html = "";
  const tree = desc.support.language.parser.parse(code);
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, classes) => {
      html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
    },
    () => (html += "\n"),
  );
  return html;
}

/** Adds data-line to block tokens, ids to headings and checkboxes to task list items. */
function annotate(state: StateCore) {
  const tokens = state.tokens;
  const slug = createSlugger();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.map && token.nesting !== -1) token.attrSet("data-line", String(token.map[0]));

    if (token.type === "heading_open") {
      token.attrSet("id", slug(tokens[i + 1]?.content ?? ""));
    }

    // "- [ ] task" and "- [x] done"
    if (token.type === "inline" && tokens[i - 1]?.type === "paragraph_open" && tokens[i - 2]?.type === "list_item_open") {
      const match = /^\[([ xX])\]\s/.exec(token.content);
      const first = token.children?.[0];
      if (match && first?.type === "text") {
        first.content = first.content.slice(match[0].length);
        const box = new state.Token("html_inline", "", 0);
        // Not an <input>: the sanitizer drops every form control (see FORBID_TAGS), and a disabled checkbox
        // needs none. The span is drawn by the preview's CSS.
        box.content = `<span class="task-box" role="checkbox" aria-disabled="true" aria-checked="${match[1] === " " ? "false" : "true"}"></span> `;
        token.children!.unshift(box);
        tokens[i - 2].attrJoin("class", "task-list-item");
      }
    }
  }
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: false, highlight });
md.use(mathPlugin, () => onLanguageLoaded?.());
md.core.ruler.push("kladde_annotate", annotate);

// Fenced code: keep the data-line attribute, which the default renderer drops.
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] ?? "";
  const line = token.attrGet("data-line");
  if (lang === "mermaid") {
    // The source stays readable in the placeholder until the diagram is drawn (or if drawing fails).
    return `<div class="mermaid-block" data-mermaid data-line="${line ?? ""}"><pre><code>${escapeHtml(token.content)}</code></pre></div>\n`;
  }
  if (lang === "math") return renderMathFence(token.content, String(line ?? ""), () => onLanguageLoaded?.());
  const body = highlight(token.content, lang) || escapeHtml(token.content);
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre data-line="${line ?? ""}"><code${cls}>${body}</code></pre>\n`;
};

let currentBaseDir: string | null = null;

const isExternal = (url: string) => /^(https?:|data:|blob:|mailto:|asset:|#)/i.test(url);

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src");
    if (src && !isExternal(src) && currentBaseDir) {
      const path = resolvePath(currentBaseDir, decodeURIComponent(src.split(/[?#]/)[0]));
      node.setAttribute("src", convertFileSrc(path));
    }
    node.setAttribute("loading", "lazy");
  }
});

/**
 * What the sanitizer removes on top of DOMPurify's defaults. The preview is a document, not an application:
 * a <form> (or a button with formaction) navigates the whole window to its action when it is clicked, and the
 * CSP's form-action 'none' and the navigation guard in Rust are only the second and third line. The rest is
 * already outside DOMPurify's lists and is named so that a change of defaults cannot let it in.
 */
export const ACTIVE_TAGS = [
  "form", "input", "button", "select", "option", "optgroup", "datalist", "textarea", "fieldset",
  "meta", "link", "base", "iframe", "frame", "frameset", "object", "embed", "portal",
  // An image map's <area href> navigates the window like a link, past the click handler of the preview
  // (`closest("a")`): with href="" or "/" it even reloads Kladde.
  "map", "area",
];
/** `<style>` is forbidden in Markdown, but a Mermaid diagram carries its own inside the SVG. */
export const FORBID_TAGS = ["style", ...ACTIVE_TAGS];
export const FORBID_ATTR = ["formaction", "formmethod", "formtarget", "formenctype", "form", "usemap"];

/**
 * Removes the elements of `ACTIVE_TAGS` and the attributes of `FORBID_ATTR` from markup that was not sanitized by
 * us (Mermaid's SVG, which only passes Mermaid's own DOMPurify call with its default settings). Returns the
 * parsed nodes, ready to be inserted; nothing was in the document yet while it was parsed.
 */
export function stripActive(markup: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const { content } = template;
  for (const el of content.querySelectorAll(ACTIVE_TAGS.join(","))) el.remove();
  for (const el of content.querySelectorAll(FORBID_ATTR.map((a) => `[${a}]`).join(","))) {
    for (const a of FORBID_ATTR) el.removeAttribute(a);
  }
  return content;
}

/** Renders Markdown to sanitized HTML. `baseDir` resolves relative image paths. */
export function renderMarkdown(source: string, baseDir: string | null): string {
  currentBaseDir = baseDir;
  const html = md.render(source);
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR, ADD_ATTR: ["target"] });
}

export function renderSvg(source: string): string {
  return `<div class="svg-preview"><img alt="SVG preview" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}"></div>`;
}
