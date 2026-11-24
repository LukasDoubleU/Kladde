// Math in Markdown: $inline$, $$display$$ and ```math fences, rendered with KaTeX.
//
// KaTeX and its stylesheet and fonts are loaded on first use, so documents without math never pay for
// them. Until the chunk arrived the TeX source is shown and the preview re-renders when it is there.
// The output is plain HTML (no MathML), so it passes through DOMPurify unchanged.

import MarkdownIt, { type StateBlock, type StateInline } from "markdown-it";
import { matchInlineMath } from "./math-scan.ts";

type Katex = typeof import("katex").default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;
/** Everyone who asked for a formula while KaTeX was still loading (the preview, the editor's Live Preview). */
const waiting = new Set<() => void>();

function load(onLoaded: () => void) {
  waiting.add(onLoaded);
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([module]) => {
      katex = module.default;
      const callbacks = [...waiting];
      waiting.clear();
      for (const callback of callbacks) callback();
    })
    .catch(() => {
      loading = null; // allow another attempt on the next render
    });
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What KaTeX makes of a formula: its HTML, the reason it refused, or "pending" while it is still loading. */
export type TexResult = { kind: "ok"; html: string } | { kind: "error"; message: string } | { kind: "pending" };

const MAX_CACHED = 400;
const rendered = new Map<string, TexResult>();

/**
 * Renders TeX with KaTeX (the one place that decides its options), cached by formula. `onLoaded` runs once the lazily
 * loaded KaTeX has arrived, when the answer was "pending". Shared by the preview and the editor's Live Preview.
 */
export function texToHtml(tex: string, display: boolean, onLoaded: () => void): TexResult {
  if (!katex) {
    load(onLoaded);
    return { kind: "pending" };
  }
  const key = `${display ? "d" : "i"}${tex}`;
  const hit = rendered.get(key);
  if (hit) return hit;
  let result: TexResult;
  try {
    const html = katex.renderToString(tex, { displayMode: display, output: "html", throwOnError: true, strict: "ignore" });
    result = { kind: "ok", html };
  } catch (e) {
    result = { kind: "error", message: String((e as Error).message ?? e).replace(/^KaTeX parse error: /, "") };
  }
  if (rendered.size >= MAX_CACHED) rendered.delete(rendered.keys().next().value!);
  rendered.set(key, result);
  return result;
}

/** Renders TeX to HTML; shows the source (and the error) when KaTeX is not ready or rejects it. */
function renderTex(tex: string, display: boolean, line: string | null, onLoaded: () => void): string {
  // Only block-level formulas get a div; $ inside a paragraph stays a span.
  const tag = line === null ? "span" : "div";
  const attrs = line === null ? "" : ` data-line="${line}"`;
  const kind = line === null ? "math-inline" : "math-block";
  const result = texToHtml(tex, display, onLoaded);
  if (result.kind === "pending") return `<${tag} class="math ${kind} math-pending"${attrs}>${escapeHtml(tex)}</${tag}>`;
  if (result.kind === "ok") return `<${tag} class="math ${kind}"${attrs}>${result.html}</${tag}>`;
  const message = escapeHtml(result.message);
  return `<${tag} class="math math-error ${kind}" title="${message.replace(/"/g, "&quot;")}"${attrs}>${escapeHtml(tex)}</${tag}>`;
}

function inlineRule(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  const found = matchInlineMath(src, pos, posMax);
  if (!found) return false;
  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = found.content;
    if (found.display) token.meta = { display: true };
  }
  state.pos = found.end;
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
