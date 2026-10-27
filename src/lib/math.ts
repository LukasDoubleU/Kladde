// Math in Markdown: $inline$, $$display$$ and ```math fences, rendered with KaTeX.
//
// KaTeX and its stylesheet and fonts are loaded on first use, so documents without math never pay for
// them. Until the chunk arrived the TeX source is shown and the preview re-renders when it is there.
// The output is plain HTML (no MathML), so it passes through DOMPurify unchanged.

import MarkdownIt, { type StateBlock, type StateInline } from "markdown-it";

type Katex = typeof import("katex").default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;

function load(onLoaded: () => void) {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([module]) => {
      katex = module.default;
      onLoaded();
    })
    .catch(() => {
      loading = null; // allow another attempt on the next render
    });
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Renders TeX to HTML; shows the source (and the error) when KaTeX is not ready or rejects it. */
function renderTex(tex: string, display: boolean, line: string | null, onLoaded: () => void): string {
  // Only block-level formulas get a div; $ inside a paragraph stays a span.
  const tag = line === null ? "span" : "div";
  const attrs = line === null ? "" : ` data-line="${line}"`;
  if (!katex) {
    load(onLoaded);
    return `<${tag} class="math ${line === null ? "math-inline" : "math-block"} math-pending"${attrs}>${escapeHtml(tex)}</${tag}>`;
  }
  try {
    const html = katex.renderToString(tex, { displayMode: display, output: "html", throwOnError: true, strict: "ignore" });
    return `<${tag} class="math ${line === null ? "math-inline" : "math-block"}"${attrs}>${html}</${tag}>`;
  } catch (e) {
    const message = escapeHtml(String((e as Error).message ?? e).replace(/^KaTeX parse error: /, ""));
    return `<${tag} class="math math-error ${line === null ? "math-inline" : "math-block"}" title="${message.replace(/"/g, "&quot;")}"${attrs}>${escapeHtml(tex)}</${tag}>`;
  }
}

/** Index of the closing "$" for an inline formula that opens before `start`, or -1. */
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

function inlineRule(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  if (src.charCodeAt(pos) !== 0x24) return false;

  // $$ inside a paragraph is display math that stays in the text flow.
  if (src.charCodeAt(pos + 1) === 0x24) {
    const end = src.indexOf("$$", pos + 2);
    if (end < 0 || end >= posMax || end === pos + 2) return false;
    if (!silent) state.push("math_inline", "", 0).content = src.slice(pos + 2, end);
    if (!silent) state.tokens[state.tokens.length - 1].meta = { display: true };
    state.pos = end + 2;
    return true;
  }

  const next = src.charCodeAt(pos + 1);
  if (pos + 1 >= posMax || next === 0x20 || next === 0x09 || next === 0x0a) return false;
  const end = findInlineEnd(src, pos + 1, posMax);
  if (end < 0 || end === pos + 1) return false;
  if (!silent) state.push("math_inline", "", 0).content = src.slice(pos + 1, end);
  state.pos = end + 1;
  return true;
}

function blockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== "$$") return false;
  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let lastLine = "";
  let found = false;
  let next = startLine;

  if (silent) return true;
  if (firstLine.trim().endsWith("$$")) {
    // single line: $$ x $$
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }
  while (!found) {
    next++;
    if (next >= endLine) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (state.sCount[next] < state.blkIndent) break;
    const line = state.src.slice(pos, max);
    if (line.trim().endsWith("$$")) {
      lastLine = line.trim().slice(0, -2);
      found = true;
    }
  }
  if (!found) return false;

  const token = state.push("math_block", "", 0);
  token.block = true;
  token.content =
    (firstLine.trim() ? firstLine + "\n" : "") +
    state.getLines(startLine + 1, next, state.tShift[startLine], true) +
    (lastLine.trim() ? lastLine : "");
  token.map = [startLine, next + 1];
  token.markup = "$$";
  state.line = next + 1;
  return true;
}

/** Adds math to a markdown-it instance. `onLoaded` runs when KaTeX finished loading. */
export function mathPlugin(md: InstanceType<typeof MarkdownIt>, onLoaded: () => void) {
  md.inline.ruler.after("escape", "math_inline", inlineRule);
  md.block.ruler.after("blockquote", "math_block", blockRule, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules.math_inline = (tokens, idx) =>
    renderTex(tokens[idx].content, !!tokens[idx].meta?.display, null, onLoaded);
  md.renderer.rules.math_block = (tokens, idx) =>
    renderTex(tokens[idx].content.trim(), true, String(tokens[idx].attrGet("data-line") ?? ""), onLoaded) + "\n";
}

/** For ```math fences. */
export function renderMathFence(tex: string, line: string | null, onLoaded: () => void): string {
  return renderTex(tex.trim(), true, line, onLoaded) + "\n";
}
