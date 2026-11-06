// Links in text: finding them in a line, deciding what an href means, heading anchors and paths. Shared by the
// editor (Ctrl+click, "Open link at cursor") and the Markdown preview, so both open an href the same way.
// No imports, so the unit tests can load it directly.

// ---------------------------------------------------------------- paths

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

// ---------------------------------------------------------------- heading anchors

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Turns heading texts into unique anchor ids, in document order: a repeated heading gets "-1", "-2", … */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

/**
 * The anchor id of every heading of a Markdown source, mapped to the 0-based index of its line, using the
 * slug rule of the preview. Covers ATX (`## Title`) and single- or multi-line setext headings outside fenced
 * code; headings nested in block quotes or lists are not seen (the preview anchors them, so their numbering
 * can differ in documents that repeat such a title).
 */
export function headingAnchors(lines: Iterable<string>): Map<string, number> {
  const ids = new Map<string, number>();
  const slug = createSlugger();
  const add = (text: string, line: number) => {
    const id = slug(text);
    if (!ids.has(id)) ids.set(id, line);
  };
  let fence: { char: string; length: number } | null = null;
  let paragraph: string[] = [];
  let paragraphStart = 0;
  let index = -1;
  for (const line of lines) {
    index++;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      paragraph = [];
      continue;
    }
    if (line.trim() === "") {
      paragraph = [];
      continue;
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/.exec(line);
    if (atx) {
      add((atx[1] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, ""), index);
      paragraph = [];
      continue;
    }
    if (paragraph.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      add(paragraph.join("\n"), paragraphStart);
      paragraph = [];
      continue;
    }
    // Rules, quotes, lists and indented code are not paragraph text for a setext underline.
    if (/^ {0,3}(?:(?:[-*_][ \t]*){3,}$|>|[-+*][ \t]|\d{1,9}[.)][ \t])/.test(line) || /^(?: {4}|\t)/.test(line)) {
      paragraph = [];
      continue;
    }
    if (!paragraph.length) paragraphStart = index;
    paragraph.push(line);
  }
  return ids;
}

// ---------------------------------------------------------------- what an href means

export type HrefTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string };

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * What a link target opens: the browser for http(s) and mailto, a heading of the same document for `#id`, or a
 * file in Kladde for a relative path (a drive path too; `?query` and `#fragment` are dropped, `%20` decoded).
 * Everything else is rejected (null): other schemes (`file:`, `javascript:`, custom ones), network (UNC) paths
 * that would make Windows contact a server, and anything with a colon in the path (drive-less device or stream
 * names). Opening a file only ever opens it as text, never runs it.
 */
export function classifyHref(href: string): HrefTarget | null {
  const value = href.trim();
  if (!value) return null;
  if (value.startsWith("#")) return value.length > 1 ? { kind: "anchor", id: decode(value.slice(1)) } : null;
  if (/^(?:https?:\/\/|mailto:)/i.test(value)) return { kind: "external", url: value };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(value)) return null;
  if (/^(?:\\\\|\/\/)/.test(value)) return null;
  const path = decode(value.split(/[?#]/)[0]);
  const rest = /^[a-zA-Z]:[\\/]/.test(path) ? path.slice(2) : path;
  if (!path || rest.includes(":") || /[\0\r\n]/.test(path)) return null;
  return { kind: "file", path };
}

// ---------------------------------------------------------------- finding links in a line

export interface LinkSpan {
  /** Offsets in the line text. */
  from: number;
  to: number;
  href: string;
}

/** Lines longer than this are searched only around the position, so a minified file stays cheap. */
const WINDOW = 10_000;

const URL_START = /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(?:https?:\/\/|mailto:)[^\s<>"`\\\u201c\u201d\u2018\u2019]+/gi;

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Cuts the punctuation that belongs to the sentence, not to the URL, off its end. */
function trimUrl(url: string): string {
  for (;;) {
    const last = url[url.length - 1];
    if (last && ".,:;!?'*_~".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const open = last && CLOSERS[last];
    if (open && count(url, last) > count(url, open)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function count(text: string, char: string): number {
  let n = 0;
  for (let i = text.indexOf(char); i >= 0; i = text.indexOf(char, i + 1)) n++;
  return n;
}

const VALID_URL = /^(?:https?:\/\/[\p{L}\p{N}[]|mailto:[^@\s]+@\S)/iu;

/** The URLs (http, https, mailto) of a line. */
export function findUrls(text: string, around?: number): LinkSpan[] {
  const [lo, hi] = windowOf(text, around);
  const found: LinkSpan[] = [];
  URL_START.lastIndex = lo;
  for (let m = URL_START.exec(text); m && m.index < hi; m = URL_START.exec(text)) {
    const url = trimUrl(m[0]);
    const to = m.index + m[0].length;
    // A match cut by the end of the window may be a part of a longer URL.
    if (!VALID_URL.test(url) || (to >= hi && hi < text.length)) continue;
    found.push({ from: m.index, to: m.index + url.length, href: url });
  }
  return found;
}

function windowOf(text: string, around?: number): [number, number] {
  if (text.length <= 2 * WINDOW || around === undefined) return [0, text.length];
  const lo = Math.max(0, around - WINDOW);
  // The start of the window is not a place where a URL can begin: skip to the next boundary.
  const skip = lo === 0 ? 0 : text.slice(lo, lo + 256).search(/[\s"'<>(]/) + 1;
  return [lo + skip, Math.min(text.length, around + WINDOW)];
}

/** The end of a link destination that starts at `start` (just after "("), or null. */
function parseDestination(text: string, start: number, hi: number): { href: string; end: number } | null {
  let i = start;
  while (i < hi && (text[i] === " " || text[i] === "\t")) i++;
  let href: string;
  if (text[i] === "<") {
    const close = text.indexOf(">", i + 1);
    if (close < 0 || close >= hi || /[\r\n<]/.test(text.slice(i + 1, close))) return null;
    href = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const from = i;
    let depth = 0;
    for (; i < hi; i++) {
      const c = text[i];
      if (c === "\\") i++;
      else if (c === " " || c === "\t") break;
      else if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (i >= hi) return null;
    href = text.slice(from, i);
  }
  href = href.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  while (i < hi && (text[i] === " " || text[i] === "\t")) i++;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === "(") {
    const close = text.indexOf(quote === "(" ? ")" : quote, i + 1);
    if (close < 0 || close >= hi) return null;
    i = close + 1;
    while (i < hi && (text[i] === " " || text[i] === "\t")) i++;
  }
  return text[i] === ")" && i < hi ? { href, end: i + 1 } : null;
}

/** The `[` that opens the link text ending at the `]` at `close`, or -1. */
function openingBracket(text: string, close: number, lo: number): number {
  let depth = 0;
  for (let i = close - 1; i >= lo; i--) {
    const c = text[i];
    if (c !== "[" && c !== "]") continue;
    let slashes = 0;
    while (text[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2) continue;
    if (c === "]") depth++;
    else if (depth === 0) return i;
    else depth--;
  }
  return -1;
}

interface MarkdownLink extends LinkSpan {
  /** Where the target `(…)` starts. */
  targetFrom: number;
}

/** The inline links `[text](target)` and images `![alt](target)` of a line, nested ones included. */
function markdownLinks(text: string, around?: number): MarkdownLink[] {
  const [lo, hi] = windowOf(text, around);
  const found: MarkdownLink[] = [];
  for (let i = text.indexOf("](", lo); i >= 0 && i < hi; i = text.indexOf("](", i + 1)) {
    if (text[i - 1] === "\\") continue;
    const dest = parseDestination(text, i + 2, hi);
    const open = dest ? openingBracket(text, i, lo) : -1;
    if (!dest || open < 0) continue;
    found.push({ from: open > lo && text[open - 1] === "!" ? open - 1 : open, to: dest.end, href: dest.href, targetFrom: i + 1 });
  }
  return found;
}

/**
 * The link at an offset of a line, or null. Offsets at either end of a link count as on it, so a cursor right
 * after a URL opens it. Markdown adds `[text](target)`, `![alt](target)`; autolinks `<https://…>` are URLs.
 * In `[![badge](image)](page)` the text opens the outer link, the inner target the inner one.
 */
export function linkAt(text: string, offset: number, markdown: boolean): LinkSpan | null {
  if (markdown) {
    const inside = markdownLinks(text, offset).filter((l) => offset >= l.from && offset <= l.to);
    const target = inside.filter((l) => offset >= l.targetFrom).sort((a, b) => b.from - a.from)[0];
    const outer = inside.sort((a, b) => a.from - b.from || b.to - a.to)[0];
    const link = target ?? outer;
    if (link) return { from: link.from, to: link.to, href: link.href };
  }
  return findUrls(text, offset).find((l) => offset >= l.from && offset <= l.to) ?? null;
}
