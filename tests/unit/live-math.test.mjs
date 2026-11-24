// Unit tests for math and diagrams in Live Preview: which text is a formula, which fences are blocks, and that
// the editor and the preview (markdown-it) agree. No DOM.
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const lib = (name) => pathToFileURL(resolve(import.meta.dirname, `../../src/lib/${name}`)).href;
const { matchInlineMath, matchDisplayBlock, scanInlineMath } = await import(lib("math-scan.ts"));
const { findMathBlocks } = await import(lib("live-preview-math.ts"));
const { buildLivePreview, frontMatterEnd } = await import(lib("live-preview-core.ts"));
const { mathPlugin } = await import(lib("math.ts"));
const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
const { ensureSyntaxTree } = await import("@codemirror/language");
const { EditorState } = await import("@codemirror/state");
const { default: MarkdownIt } = await import("markdown-it");

const inline = (text) => scanInlineMath(text).map((m) => [text.slice(m.from, m.end), m.content, m.display]);

test("inline formulas: $x$ and $$x$$, with the dollar rules of the preview", () => {
  assert.deepEqual(inline("a $x^2$ b"), [["$x^2$", "x^2", false]]);
  assert.deepEqual(inline("a $$x^2$$ b"), [["$$x^2$$", "x^2", true]]);
  assert.deepEqual(inline("$a$ and $b$"), [["$a$", "a", false], ["$b$", "b", false]]);
  assert.deepEqual(inline("$a\\$b$"), [["$a\\$b$", "a\\$b", false]], "an escaped dollar inside stays inside");
});

test("dollars that are money or code are text", () => {
  assert.deepEqual(inline("it costs $5 and $6 today"), []);
  assert.deepEqual(inline("$5 and $10"), []);
  assert.deepEqual(inline("a $ b $ c"), [], "spaces inside the delimiters");
  assert.deepEqual(inline("a $x $ c"), [], "a space before the closing dollar");
  assert.deepEqual(inline("a \\$x$ c"), [], "an escaped opening dollar");
  assert.deepEqual(inline("only $ one"), []);
  assert.deepEqual(inline("empty $$ here"), []);
  assert.deepEqual(inline("code `$x$` here"), [], "a code span");
  assert.deepEqual(inline("code ``a ` $x$`` and $y$"), [["$y$", "y", false]], "a longer run of backticks");
  assert.deepEqual(inline("`$x` then $y$"), [["$y$", "y", false]]);
  assert.deepEqual(inline("a $x and no end"), []);
});

test("display blocks: one line or several, closed or not at all", () => {
  const block = (text, first = 0) => {
    const lines = text.split("\n");
    return matchDisplayBlock((i) => lines[i], lines.length, first);
  };
  assert.deepEqual(block("$$ x = 1 $$"), { last: 0, content: "x = 1 " });
  assert.deepEqual(block("$$\nx = 1\n$$"), { last: 2, content: "\nx = 1\n" });
  assert.deepEqual(block("$$ a \\\\\n b $$"), { last: 1, content: " a \\\\\nb " });
  assert.deepEqual(block("  $$\nx\n$$"), { last: 2, content: "\nx\n" }, "up to three spaces of indent");
  assert.equal(block("    $$\nx\n$$"), null, "four spaces are a code block");
  assert.equal(block("$$\nx = 1\nnever closed"), null);
  assert.equal(block("$$\n$$"), null, "nothing in it");
  assert.equal(block("text $$ x $$"), null, "must start the line");
});

/** The blocks of a document. */
function blocksOf(text) {
  const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  return findMathBlocks(state.doc, tree, frontMatterEnd(state.doc)).map((b) => [b.kind, text.slice(b.from, b.to), b.source]);
}

test("blocks: display math, math fences and mermaid fences", () => {
  const doc = "# T\n\n$$\nx = 1\n$$\n\n$$ y $$\n\n```math\na^2\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nend";
  assert.deepEqual(blocksOf(doc), [
    ["display", "$$\nx = 1\n$$", "x = 1"],
    ["display", "$$ y $$", "y"],
    ["mathfence", "```math\na^2\n```", "a^2"],
    ["mermaid", "```mermaid\ngraph TD\n  A-->B\n```", "graph TD\n  A-->B\n"],
  ]);
});

test("blocks: not in code, HTML, tables, quotes, and not when unclosed", () => {
  assert.deepEqual(blocksOf("```\n$$\nx\n$$\n```\n"), [], "a code fence");
  assert.deepEqual(blocksOf("```js\n$$ x $$\n```\n"), []);
  assert.deepEqual(blocksOf("para\n\n    $$\n    x\n    $$\n"), [], "an indented code block");
  assert.deepEqual(blocksOf("<div>\n$$ x $$\n</div>\n"), [], "an HTML block");
  assert.deepEqual(blocksOf("> quote\n$$ x $$\n"), [], "a lazy quote line");
  assert.deepEqual(blocksOf("$$\nnever closed\n"), []);
  assert.deepEqual(blocksOf("```mermaid\ngraph TD\n"), [], "a fence that is not closed is not a diagram");
  assert.deepEqual(blocksOf("```python\nx\n```\n"), []);
  assert.deepEqual(blocksOf("```mermaid\n```\n"), [], "an empty diagram");
  assert.deepEqual(blocksOf("> ```mermaid\n> graph TD\n> ```\n"), [], "a fence in a quotation stays code");
  assert.deepEqual(blocksOf("---\ntitle: x\n---\n\n$$ y $$\n").map((b) => b[0]), ["display"], "after front matter");
});

test("blocks: a fence in a list item counts", () => {
  assert.deepEqual(blocksOf("- item\n\n  ```math\n  x\n  ```\n").map((b) => b[0]), ["mathfence"]);
});

/** The specs of inline math in a document, with the cursor at `at`. */
function mathSpecs(text, at = 0, blocks = []) {
  const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  return buildLivePreview({
    doc: state.doc,
    tree,
    selection: [{ from: at, to: at }],
    visible: [{ from: 0, to: state.doc.length }],
    editable: true,
    blocks,
  });
}

test("inline math becomes a widget until the cursor touches it", () => {
  const doc = "x\n\nSee $a_b$ and `$c$` and costs $5 here and \\$d here.";
  const away = mathSpecs(doc);
  assert.deepEqual(
    away.filter((s) => s.kind === "widget").map((s) => [doc.slice(s.from, s.to), s.widget]),
    [["$a_b$", { type: "math", tex: "a_b", display: false }]],
  );
  const at = doc.indexOf("a_b");
  const near = mathSpecs(doc, at);
  assert.equal(near.filter((s) => s.kind === "widget").length, 0);
  assert.deepEqual(near.filter((s) => s.kind === "mark" && s.cls === "cm-lp-math-src").map((s) => doc.slice(s.from, s.to)), ["$a_b$"]);
});

test("nothing inside a formula is styled as Markdown", () => {
  const doc = "x\n\n$a*b$ and $c*d$ and *real*";
  const specs = mathSpecs(doc);
  const marks = specs.filter((s) => s.kind === "hide").map((s) => doc.slice(s.from, s.to));
  assert.deepEqual(specs.filter((s) => s.kind === "widget").length, 2);
  assert.deepEqual(marks, ["*", "*"], "only the emphasis marks of the text outside the formulas");
});

test("math in links' addresses, HTML and tables is left alone", () => {
  const doc = "x\n\n[a](http://example.com/$x$/y) <span title=\"$z$\"> | $q$ |\n\n| a | b |\n|---|---|\n| $m$ | 2 |\n";
  assert.deepEqual(mathSpecs(doc).filter((s) => s.kind === "widget" && s.widget.type === "math").map((s) => doc.slice(s.from, s.to)), ["$q$"]);
});

test("the display blocks that are drawn own their lines", () => {
  const doc = "x\n\n$$\na_b *c*\n$$\n\n- *item*";
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const blocks = findMathBlocks(state.doc, ensureSyntaxTree(state, state.doc.length, 5000));
  const specs = mathSpecs(doc, 0, blocks);
  assert.deepEqual(specs.filter((s) => s.kind === "hide").map((s) => s.from).every((from) => from > doc.indexOf("$$\n\n- ")), true);
  assert.equal(specs.filter((s) => s.kind === "widget" && s.widget.type === "math").length, 0, "the block is the field's, not an inline widget");
});

test("an unclosed math fence in the cursor's block keeps showing code", () => {
  const doc = "```mermaid\ngraph TD\n```\n\nx";
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const blocks = findMathBlocks(state.doc, ensureSyntaxTree(state, state.doc.length, 5000));
  assert.equal(blocks.length, 1);
  const inside = mathSpecs(doc, 14, blocks);
  assert.ok(inside.some((s) => s.kind === "line" && s.cls.includes("cm-lp-codeblock")), "touched: shaded like code");
  const away = mathSpecs(doc, doc.length, blocks);
  assert.equal(away.some((s) => s.kind === "line"), false, "drawn: nothing decorates its lines");
});

test("the editor finds the same inline formulas as the preview", () => {
  const md = new MarkdownIt({ html: true });
  md.use(mathPlugin, () => {});
  const corpus = [
    "a $x^2$ b",
    "a $$x$$ b",
    "it costs $5 and $6",
    "$a$ and $b$ and $c d$",
    "a \\$x$ b",
    "$a\\$b$",
    "`$x$` and $y$",
    "a $ b $ c",
    "$x $ y",
    "just $ one",
    "$1$ and $a1$ then $2",
    "price $3.50 or $x_1$",
    "$$ a $$ and $$b$$",
    "**$x$** and _$y$_",
    "empty $$ done",
  ];
  for (const text of corpus) {
    const tokens = md.parseInline(text, {})[0].children.filter((t) => t.type === "math_inline");
    const preview = tokens.map((t) => [t.content, !!t.meta?.display]);
    const editor = scanInlineMath(text).map((m) => [m.content, m.display]);
    assert.deepEqual(editor, preview, text);
  }
});

test("matchInlineMath is what the preview's rule calls", () => {
  assert.equal(matchInlineMath("$x$", 0, 3)?.end, 3);
  assert.equal(matchInlineMath("x$y$", 0, 4), null, "not at a dollar");
});
