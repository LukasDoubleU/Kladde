// Strikethrough with one or two tildes, as GitHub-flavoured Markdown has it: `~text~` and `~~text~~`. An opener
// only closes with a closer of the same length, and three or more tildes are no strikethrough. Both Markdown
// parsers of Kladde only know `~~` out of the box, so this module teaches them the single tilde:
// - `tildeStrikethrough` replaces the GFM strikethrough of @lezer/markdown (the editor's syntax tree, so the
//   highlighting and Live Preview);
// - `singleTildePlugin` adds the single tilde to markdown-it (the preview), next to its own `~~` rule.

import type { DelimiterType, InlineContext, MarkdownConfig } from "@lezer/markdown";
import type MarkdownIt from "markdown-it";
import type { StateInline } from "markdown-it";

const TILDE = 0x7e;

// The same rules for "can open" and "can close" as Lezer's own `~~` (the flanking rules of GFM).
const PUNCTUATION = /[\p{S}\p{P}]/u;

/** Two delimiter types, so that a single tilde only pairs with a single one and a double with a double. */
const single: DelimiterType = { resolve: "Strikethrough", mark: "StrikethroughMark" };
const double: DelimiterType = { resolve: "Strikethrough", mark: "StrikethroughMark" };

/** Replaces Lezer's `~~` strikethrough (from GFM) with one for `~` and `~~`; the node names stay the same. */
export const tildeStrikethrough: MarkdownConfig = {
  remove: ["Strikethrough"],
  parseInline: [
    {
      name: "TildeStrikethrough",
      parse(cx: InlineContext, next: number, pos: number) {
        // Only at the start of a run of tildes, and only runs of one or two.
        if (next !== TILDE || cx.char(pos - 1) === TILDE) return -1;
        const size = cx.char(pos + 1) === TILDE ? 2 : 1;
        if (cx.char(pos + size) === TILDE) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + size, pos + size + 1);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCTUATION.test(before);
        const pAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          size === 1 ? single : double,
          pos,
          pos + size,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

/** A delimiter marker of its own for the single tilde, so markdown-it never pairs it with half of a `~~`. */
const SINGLE_MARKER = 0x1007e;

function tokenizeSingle(state: StateInline, silent: boolean): boolean {
  if (silent || state.src.charCodeAt(state.pos) !== TILDE) return false;
  const scanned = state.scanDelims(state.pos, true);
  // Two or more are markdown-it's own rule (`~~`), which runs before this one.
  if (scanned.length !== 1) return false;
  const token = state.push("text", "", 0);
  token.content = "~";
  state.delimiters.push({
    marker: SINGLE_MARKER,
    length: 0,
    token: state.tokens.length - 1,
    end: -1,
    open: scanned.can_open,
    close: scanned.can_close,
  });
  state.pos += 1;
  return true;
}

function pairSingles(state: StateInline, delimiters: StateInline["delimiters"]) {
  for (const start of delimiters) {
    if (start.marker !== SINGLE_MARKER || start.end === -1) continue;
    const end = delimiters[start.end];
    Object.assign(state.tokens[start.token], { type: "s_open", tag: "s", nesting: 1, markup: "~", content: "" });
    Object.assign(state.tokens[end.token], { type: "s_close", tag: "s", nesting: -1, markup: "~", content: "" });
  }
}

/** markdown-it plugin: `~text~` as strikethrough, besides the built-in `~~text~~`. */
export function singleTildePlugin(md: InstanceType<typeof MarkdownIt>) {
  md.inline.ruler.after("strikethrough", "strikethrough_single", tokenizeSingle);
  md.inline.ruler2.after("strikethrough", "strikethrough_single", (state: StateInline) => {
    pairSingles(state, state.delimiters);
    for (const meta of state.tokens_meta) if (meta?.delimiters) pairSingles(state, meta.delimiters);
    return false;
  });
}
