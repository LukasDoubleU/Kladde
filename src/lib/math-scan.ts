// The rules that decide what is math in Markdown, pure and without dependencies: `math.ts` (the preview's
// markdown-it plugin) and Live Preview in the editor both use them, so a formula is a formula in both.
//
// - `$inline$` needs a non-space after the opening and before the closing `$`, and no digit right after the closing
//   one, so "$5 and $10" stays text. A backslash escapes the next character (`\$`).
// - `$$display$$` inside a paragraph stays in the text flow.
// - A line that starts with `$$` opens a display block that ends at the next line ending in `$$` (or on the same line).

export interface InlineMath {
  /** Index after the closing delimiter. */
  end: number;
  content: string;
  display: boolean;
}

/** Index of the closing "$" for an inline formula whose content starts at `start`, or -1. */
function findInlineEnd(src: string, start: number, max: number): number {
  for (let i = start; i < max; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c /* \ */) {
      i++; // skip the escaped character
    } else if (c === 0x24 /* $ */) {
      // "$5 and $10": the closing $ needs non-space before it and no digit after it
      const before = src.charCodeAt(i - 1);
      const after = src.charCodeAt(i + 1);
      if (before === 0x20 || before === 0x09 || before === 0x0a) return -1;
      if (after >= 0x30 && after <= 0x39) return -1;
      return i;
    }
  }
  return -1;
}

/** The inline formula that starts with the `$` at `pos` (the text ends at `max`), or null. */
export function matchInlineMath(src: string, pos: number, max: number): InlineMath | null {
  if (src.charCodeAt(pos) !== 0x24) return null;

  // $$ inside a paragraph is display math that stays in the text flow.
  if (src.charCodeAt(pos + 1) === 0x24) {
    const end = src.indexOf("$$", pos + 2);
    if (end < 0 || end >= max || end === pos + 2) return null;
    return { end: end + 2, content: src.slice(pos + 2, end), display: true };
  }

  const next = src.charCodeAt(pos + 1);
  if (pos + 1 >= max || next === 0x20 || next === 0x09 || next === 0x0a) return null;
  const end = findInlineEnd(src, pos + 1, max);
  if (end < 0 || end === pos + 1) return null;
  return { end: end + 1, content: src.slice(pos + 1, end), display: false };
}

export interface FoundMath extends InlineMath {
  from: number;
}

/**
 * The inline formulas of one line of text, left to right, as markdown-it finds them: an escaped character and a code
 * span (a run of backticks up to the next run of the same length, on this line) are skipped, so `$` in code is text.
 */
export function scanInlineMath(text: string): FoundMath[] {
  const found: FoundMath[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (c === 0x5c /* \ */) {
      i += 2;
    } else if (c === 0x60 /* ` */) {
      let n = 1;
      while (text.charCodeAt(i + n) === 0x60) n++;
      const fence = "`".repeat(n);
      let close = text.indexOf(fence, i + n);
      // The closing run must be exactly as long as the opening one.
      while (close >= 0 && text.charCodeAt(close + n) === 0x60) {
        while (text.charCodeAt(close) === 0x60) close++;
        close = text.indexOf(fence, close);
      }
      i = close < 0 ? i + n : close + n;
    } else if (c === 0x24 /* $ */) {
      const m = matchInlineMath(text, i, text.length);
      if (m) {
        found.push({ from: i, ...m });
        i = m.end;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return found;
}

export interface DisplayBlock {
  /** Index of the last line of the block (the first one, when it is closed on its own line). */
  last: number;
  /** The TeX between the delimiters. */
  content: string;
}

/** How far a display block that is not closed is searched for its end. */
export const MAX_BLOCK_LINES = 2000;

/**
 * The display block that opens on line `first` (0-based, `lines(i)` is the text of line i, `count` lines in all), or
 * null: the line must start with `$$` (up to three spaces of indent), the block ends at the first line that ends in
 * `$$`, and one that never ends is not a block.
 */
export function matchDisplayBlock(lines: (index: number) => string, count: number, first: number): DisplayBlock | null {
  const open = /^ {0,3}\$\$/.exec(lines(first));
  if (!open) return null;
  const rest = lines(first).slice(open[0].length);
  if (rest.trim().endsWith("$$")) {
    const content = rest.trim().slice(0, -2);
    return content.trim() ? { last: first, content } : null;
  }
  const parts = [rest];
  const stop = Math.min(count, first + 1 + MAX_BLOCK_LINES);
  for (let i = first + 1; i < stop; i++) {
    const line = lines(i);
    if (line.trim().endsWith("$$")) {
      parts.push(line.trim().slice(0, -2));
      const content = parts.join("\n");
      return content.trim() ? { last: i, content } : null;
    }
    parts.push(line);
  }
  return null;
}
