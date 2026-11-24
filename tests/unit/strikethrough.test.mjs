// Unit tests for strikethrough with one or two tildes (GFM): the editor's Lezer parser and the preview's markdown-it.
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const src = (name) => pathToFileURL(resolve(import.meta.dirname, "../../src/lib", name)).href;
const { tildeStrikethrough, singleTildePlugin } = await import(src("strikethrough.ts"));
const { buildLivePreview } = await import(src("live-preview-core.ts"));
const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
const { ensureSyntaxTree } = await import("@codemirror/language");
const { EditorState } = await import("@codemirror/state");
const MarkdownIt = (await import("markdown-it")).default;

function editor(doc) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [tildeStrikethrough] })] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  return { state, tree };
}

/** The text of every Strikethrough node the editor's parser finds. */
function struck(doc) {
  const { tree } = editor(doc);
  const found = [];
  tree.iterate({ enter: (n) => void (n.name === "Strikethrough" && found.push(doc.slice(n.from, n.to))) });
  return found;
}

const preview = (doc) => new MarkdownIt().use(singleTildePlugin).render(doc).trim();

test("the editor reads one and two tildes as strikethrough", () => {
  assert.deepEqual(struck("a ~one~ b"), ["~one~"]);
  assert.deepEqual(struck("a ~~two~~ b"), ["~~two~~"]);
  assert.deepEqual(struck("~one~ and ~~two~~"), ["~one~", "~~two~~"]);
  assert.deepEqual(struck("~**bold** inside~"), ["~**bold** inside~"]);
});

test("the editor pairs only runs of the same length, and not three or more", () => {
  assert.deepEqual(struck("~a~~"), []);
  assert.deepEqual(struck("~~a~"), []);
  assert.deepEqual(struck("x ~~~a~~~ y"), []);
  assert.deepEqual(struck("a ~ b ~ c"), []);
  assert.deepEqual(struck("`~a~` code"), []);
});

test("the preview renders one and two tildes as strikethrough", () => {
  assert.equal(preview("a ~one~ b"), "<p>a <s>one</s> b</p>");
  assert.equal(preview("a ~~two~~ b"), "<p>a <s>two</s> b</p>");
  assert.equal(preview("~**bold** inside~"), "<p><s><strong>bold</strong> inside</s></p>");
  assert.equal(preview("~a~~"), "<p>~a~~</p>");
  assert.equal(preview("a ~ b ~ c"), "<p>a ~ b ~ c</p>");
  assert.equal(preview("`~a~` code"), "<p><code>~a~</code> code</p>");
});

test("Live Preview hides the single tildes and strikes the text", () => {
  const doc = "plain ~gone~ text\n\nafter";
  const { state, tree } = editor(doc);
  const specs = buildLivePreview({
    doc: state.doc,
    tree,
    selection: [{ from: doc.length, to: doc.length }],
    visible: [{ from: 0, to: doc.length }],
    editable: true,
  });
  const slice = (s) => doc.slice(s.from, s.to);
  assert.deepEqual(specs.filter((s) => s.kind === "hide").map(slice), ["~", "~"]);
  assert.deepEqual(specs.filter((s) => s.kind === "mark" && s.cls === "cm-lp-strike").map(slice), ["~gone~"]);
});
