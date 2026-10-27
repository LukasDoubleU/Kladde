// Syntax highlighting for the few lines the large file viewer shows. The visible lines are parsed as one
// snippet, so a block comment or string that starts on screen still works, but nothing that began
// above the window does. Same grammar and `tok-*` classes as the editor.
import type { Language } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { logHighlighter } from "./editor";

export interface Span {
  text: string;
  /** CSS classes, empty for plain text. */
  cls: string;
  /** Part of the current search match. */
  mark?: boolean;
}

/** Characters per line that are highlighted; the rest of a very long line stays plain. */
const MAX_HIGHLIGHT = 2000;
const highlighters = [classHighlighter, logHighlighter];

export function highlightLines(parser: Language["parser"], lines: string[]): Span[][] {
  const result: Span[][] = [[]];
  const clipped = lines.map((l) => (l.length > MAX_HIGHLIGHT ? l.slice(0, MAX_HIGHLIGHT) : l));
  highlightCode(
    clipped.join("\n"),
    parser.parse(clipped.join("\n")),
    highlighters,
    (text, cls) => result[result.length - 1].push({ text, cls }),
    () => result.push([]),
  );
  lines.forEach((line, i) => {
    if (line.length > MAX_HIGHLIGHT) result[i]?.push({ text: line.slice(MAX_HIGHLIGHT), cls: "" });
  });
  // An empty snippet or line yields no spans at all.
  while (result.length < lines.length) result.push([]);
  return result.slice(0, lines.length);
}

/** Splits spans so that the characters [from, to) (UTF-16 offsets in the line) are marked. */
export function markSpans(spans: Span[], from: number, to: number): Span[] {
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
      out.push({ ...span, text: span.text.slice(a, b), mark: true });
      if (b < span.text.length) out.push({ ...span, text: span.text.slice(b) });
    }
    at = end;
  }
  return out;
}

/** UTF-16 offset of the character (code point) with the given index. */
export function unitOffset(text: string, codePoints: number): number {
  let offset = 0;
  for (let i = 0; i < codePoints && offset < text.length; i++) {
    offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
  }
  return offset;
}
