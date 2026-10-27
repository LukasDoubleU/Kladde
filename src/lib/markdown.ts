// Markdown to sanitized HTML for the preview pane.
//
// - GitHub-flavoured: tables, strikethrough, task lists, autolinks, heading anchors.
// - Local images resolve relative to the Markdown file and load through Tauri's asset protocol.
// - Code blocks are highlighted with the same grammars as the editor.
// - Block elements carry data-line attributes so the preview can follow the editor's scrolling.

import { LanguageDescription } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import MarkdownIt, { type StateCore } from "markdown-it";
import { allLanguages } from "./languages";

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

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Adds data-line to block tokens, ids to headings and checkboxes to task list items. */
function annotate(state: StateCore) {
  const tokens = state.tokens;
  const slugs = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.map && token.nesting !== -1) token.attrSet("data-line", String(token.map[0]));

    if (token.type === "heading_open") {
      const base = slugify(tokens[i + 1]?.content ?? "");
      const count = slugs.get(base) ?? 0;
      slugs.set(base, count + 1);
      token.attrSet("id", count ? `${base}-${count}` : base);
    }

    // "- [ ] task" and "- [x] done"
    if (token.type === "inline" && tokens[i - 1]?.type === "paragraph_open" && tokens[i - 2]?.type === "list_item_open") {
      const match = /^\[([ xX])\]\s/.exec(token.content);
      const first = token.children?.[0];
      if (match && first?.type === "text") {
        first.content = first.content.slice(match[0].length);
        const box = new state.Token("html_inline", "", 0);
        box.content = `<input type="checkbox" disabled${match[1] === " " ? "" : " checked"}> `;
        token.children!.unshift(box);
        tokens[i - 2].attrJoin("class", "task-list-item");
      }
    }
  }
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: false, highlight });
md.core.ruler.push("kladde_annotate", annotate);

// Fenced code: keep the data-line attribute, which the default renderer drops.
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] ?? "";
  const body = highlight(token.content, lang) || escapeHtml(token.content);
  const line = token.attrGet("data-line");
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre data-line="${line ?? ""}"><code${cls}>${body}</code></pre>\n`;
};

/** Joins a relative path onto a directory, resolving "." and "..". */
export function resolvePath(baseDir: string, relative: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("\\\\")) return relative.replace(/\//g, "\\");
  const parts = baseDir.replace(/\//g, "\\").split("\\").filter((p, i) => p !== "" || i === 0);
  for (const part of relative.replace(/\//g, "\\").split("\\")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.length > 1 && parts.pop();
    else parts.push(part);
  }
  return parts.join("\\");
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

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

/** Renders Markdown to sanitized HTML. `baseDir` resolves relative image paths. */
export function renderMarkdown(source: string, baseDir: string | null): string {
  currentBaseDir = baseDir;
  const html = md.render(source);
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style"], ADD_ATTR: ["target"] });
}

export function renderSvg(source: string): string {
  return `<div class="svg-preview"><img alt="SVG preview" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}"></div>`;
}
