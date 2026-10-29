// Caret, selection and text helpers for editing in the large file view. The document lives in Rust
// (large.rs); the view only knows the lines on screen, so everything here works on one line's text at a
// time. Positions are 0-based lines and UTF-16 columns, like JavaScript strings. No imports, so the
// unit tests can load it directly.

export interface Pos {
  line: number;
  col: number;
}

export interface Span {
  text: string;
  /** CSS classes, empty for plain text. */
  cls: string;
  /** Part of the current search match. */
  mark?: boolean;
  /** Part of the selection. */
  sel?: boolean;
  /** The caret (an empty span). */
  caret?: boolean;
}

/**
 * A column that means "the end of the line". Lines longer than 64 KB are shortened for display, so the
 * view cannot know where they end; Rust clamps a column to the real end of the line.
 */
export const LINE_END = Number.MAX_SAFE_INTEGER;

/** Editor commands (editor-actions.ts) that also work in the large file view. */
export const LARGE_COMMANDS: ReadonlySet<string> = new Set([
  "edit.deleteLine",
  "editor.cutLine",
  "editor.duplicateLine",
  "editor.copyLineUp",
  "editor.moveLineUp",
  "editor.moveLineDown",
  "editor.insertBlankLine",
  "editor.selectLine",
  "editor.toUpperCase",
  "editor.toLowerCase",
  "editor.find",
  "editor.findNext",
  "editor.findPrevious",
]);

export function comparePos(a: Pos, b: Pos): number {
  return a.line - b.line || a.col - b.col;
}

/** The two ends of a selection, start first. */
export function ordered(a: Pos, b: Pos): [Pos, Pos] {
  return comparePos(a, b) <= 0 ? [a, b] : [b, a];
}

/** Where the caret ends up after inserting `text` at `from`. */
export function advance(from: Pos, text: string): Pos {
  const lines = text.split("\n");
  if (lines.length === 1) return { line: from.line, col: from.col >= LINE_END ? LINE_END : from.col + text.length };
  return { line: from.line + lines.length - 1, col: lines[lines.length - 1].length };
}

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** One character to the left (a surrogate pair is one character). */
export function charLeft(text: string, col: number): number {
  if (col <= 0) return 0;
  return col >= 2 && isLow(text.charCodeAt(col - 1)) && !isLow(text.charCodeAt(col - 2)) ? col - 2 : col - 1;
}

export function charRight(text: string, col: number): number {
  if (col >= text.length) return text.length;
  return isLow(text.charCodeAt(col + 1)) && !isLow(text.charCodeAt(col)) ? col + 2 : col + 1;
}

type CharClass = "space" | "word" | "other";

function classOf(ch: string): CharClass {
  if (/\s/.test(ch)) return "space";
  return /[\p{L}\p{N}_]/u.test(ch) ? "word" : "other";
}

/** Start of the word left of `col`, skipping spaces first (Ctrl+Left). */
export function wordLeft(text: string, col: number): number {
  let at = Math.min(col, text.length);
  while (at > 0 && classOf(text[at - 1]) === "space") at--;
  if (at === 0) return 0;
  const cls = classOf(text[at - 1]);
  while (at > 0 && classOf(text[at - 1]) === cls) at--;
  return at;
}

/** End of the word right of `col`, skipping spaces first (Ctrl+Right). */
export function wordRight(text: string, col: number): number {
  let at = col;
  while (at < text.length && classOf(text[at]) === "space") at++;
  if (at === text.length) return at;
  const cls = classOf(text[at]);
  while (at < text.length && classOf(text[at]) === cls) at++;
  return at;
}

/** The word (or run of other characters) at `col`, for a double click. */
export function wordAt(text: string, col: number): [number, number] {
  if (!text) return [0, 0];
  const at = Math.min(col, text.length - 1);
  const cls = classOf(text[at]);
  let from = at;
  let to = at + 1;
  while (from > 0 && classOf(text[from - 1]) === cls) from--;
  while (to < text.length && classOf(text[to]) === cls) to++;
  return [from, to];
}

/** Indentation of a line, carried over to a new line by Enter. */
export function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)![0];
}

/** What Tab inserts at `col`: spaces up to the next tab stop, or a tab character. */
export function tabText(col: number, tabSize: number, insertSpaces: boolean): string {
  return insertSpaces ? " ".repeat(tabSize - (col % tabSize)) : "\t";
}

/**
 * The lines a line command works on: those touched by the selection, except a last line that the
 * selection only reaches at its very start (like CodeMirror).
 */
export function selectedLines(anchor: Pos, head: Pos): { first: number; last: number } {
  const [from, to] = ordered(anchor, head);
  const last = to.line > from.line && to.col === 0 ? to.line - 1 : to.line;
  return { first: from.line, last };
}

/** Splits spans so that the UTF-16 offsets [from, to) of the line carry `flag`. */
export function flagSpans(spans: Span[], from: number, to: number, flag: "mark" | "sel"): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const span of spans) {
    const end = at + span.text.length;
    const a = Math.max(from, at) - at;
    const b = Math.min(to, end) - at;
    if (a >= b) {
      out.push(span);
    } else {
      if (a > 0) out.push({ ...span, text: span.text.slice(0, a) });
      out.push({ ...span, text: span.text.slice(a, b), [flag]: true });
      if (b < span.text.length) out.push({ ...span, text: span.text.slice(b) });
    }
    at = end;
  }
  return out;
}

/** Inserts the caret at UTF-16 offset `col` (clamped to the end of the line). */
export function withCaret(spans: Span[], col: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  let placed = false;
  for (const span of spans) {
    const end = at + span.text.length;
    if (!placed && col >= at && col < end) {
      if (col > at) out.push({ ...span, text: span.text.slice(0, col - at) });
      out.push({ text: "", cls: "", caret: true });
      out.push({ ...span, text: span.text.slice(col - at) });
      placed = true;
    } else {
      out.push(span);
    }
    at = end;
  }
  if (!placed) out.push({ text: "", cls: "", caret: true });
  return out;
}
