// Unit tests for the pure part of Live Preview: which ranges of a Markdown document are hidden, styled or drawn
// instead, and how that follows the selection. No DOM: the document and its tree come from CodeMirror's state.
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { buildLivePreview, frontMatterEnd, touches } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../src/lib/live-preview-core.ts")).href
);
const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
const { ensureSyntaxTree } = await import("@codemirror/language");
const { EditorState } = await import("@codemirror/state");

/** Splits a test document into its text and the selection: `|` is a cursor, `⟦…⟧` a selected range. */
function parse(marked) {
  const ranges = [];
  let text = "";
  let open = -1;
  for (const ch of marked) {
    if (ch === "|") ranges.push({ from: text.length, to: text.length });
    else if (ch === "⟦") open = text.length;
    else if (ch === "⟧") {
      ranges.push({ from: open, to: text.length });
      open = -1;
    } else text += ch;
  }
  return { text, ranges: ranges.length ? ranges : [{ from: 0, to: 0 }] };
}

/** The specs of a document, with helpers to ask about them. */
function specs(marked, { editable = true, visible } = {}) {
  const { text, ranges } = parse(marked);
  const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const list = buildLivePreview({
    doc: state.doc,
    tree,
    selection: ranges,
    visible: visible ?? [{ from: 0, to: state.doc.length }],
    editable,
  });
  const slice = (s) => text.slice(s.from, s.to);
  return {
    text,
    list,
    /** The hidden pieces of text. */
    hidden: list.filter((s) => s.kind === "hide").map(slice),
    /** The text carrying a class. */
    marked: (cls) => list.filter((s) => s.kind === "mark" && s.cls.split(" ").includes(cls)).map(slice),
    /** The classes of the line that starts at `from`. */
    lineClasses: (lineNo) => {
      const start = text.split("\n").slice(0, lineNo - 1).join("\n").length + (lineNo > 1 ? 1 : 0);
      return list.filter((s) => s.kind === "line" && s.from === start).map((s) => s.cls).join(" ");
    },
    widgets: list.filter((s) => s.kind === "widget"),
  };
}

test("touches counts the ends of the element", () => {
  assert.equal(touches([{ from: 5, to: 5 }], 5, 8), true);
  assert.equal(touches([{ from: 8, to: 8 }], 5, 8), true);
  assert.equal(touches([{ from: 9, to: 9 }], 5, 8), false);
  assert.equal(touches([{ from: 0, to: 20 }], 5, 8), true);
  assert.equal(touches([{ from: 0, to: 0 }, { from: 6, to: 6 }], 5, 8), true);
});

test("emphasis marks are hidden until a selection touches the element", () => {
  const away = specs("|plain **bold** and *it* and ~~gone~~ and `code`");
  assert.deepEqual(away.hidden, ["**", "**", "*", "*", "~~", "~~", "`", "`"]);
  assert.deepEqual(away.marked("cm-lp-strong"), ["**bold**"]);
  assert.deepEqual(away.marked("cm-lp-em"), ["*it*"]);
  assert.deepEqual(away.marked("cm-lp-strike"), ["~~gone~~"]);
  assert.deepEqual(away.marked("cm-lp-code"), ["`code`"]);

  const inBold = specs("plain **bo|ld** and *it*");
  assert.deepEqual(inBold.hidden, ["*", "*"], "only the italic element, which the cursor does not touch, stays hidden");
  const atEdge = specs("plain **bold**| and *it*");
  assert.deepEqual(atEdge.hidden, ["*", "*"], "a cursor right behind the element reveals it");
  const beside = specs("plain **bold** |and *it*");
  assert.deepEqual(beside.hidden, ["**", "**", "*", "*"]);
});

test("a selection reveals every element it touches, and each cursor its own", () => {
  const selected = specs("⟦plain **bold** and *it*⟧ and `code`");
  assert.deepEqual(selected.hidden, ["`", "`"]);
  const two = specs("**a|** and *b|* and ~~c~~");
  assert.deepEqual(two.hidden, ["~~", "~~"]);
});

test("nested emphasis reveals the element the cursor is in, and its parents", () => {
  const outer = specs("**bold *it* more**|", {});
  assert.deepEqual(outer.hidden, ["*", "*"], "the cursor touches the strong element only");
  const inner = specs("**bold *i|t* more**");
  assert.deepEqual(inner.hidden, []);
  const bare = specs("|**bold *it* more**");
  assert.deepEqual(bare.hidden, ["*", "*"], "the cursor at the start touches the strong element, not the inner one");
  const away = specs("x |\n\n**bold *it* more**");
  assert.deepEqual(away.hidden, ["**", "*", "*", "**"]);
});

test("headings: sized by level, the marks hidden while the cursor is on another line", () => {
  const away = specs("# One\n\n## Two ##\n\n###### Six|");
  assert.equal(away.lineClasses(1), "cm-lp-h1");
  assert.equal(away.lineClasses(3), "cm-lp-h2");
  assert.equal(away.lineClasses(5), "cm-lp-h6");
  assert.deepEqual(away.hidden, ["# ", "## ", " ##"]);
  const on = specs("# One\n\n## T|wo ##\n\n###### Six");
  assert.deepEqual(on.hidden, ["# ", "###### "]);
  const empty = specs("#\n\nx|");
  assert.deepEqual(empty.hidden, ["#"]);
});

test("setext headings: text lines sized, the underline hidden until the cursor is on it", () => {
  const away = specs("Title\n=====\n\nafter|");
  assert.equal(away.lineClasses(1), "cm-lp-h1");
  assert.equal(away.lineClasses(2), "cm-lp-setext-mark");
  assert.deepEqual(away.hidden, ["====="]);
  const on = specs("Title\n===|==\n\nafter");
  assert.deepEqual(on.hidden, []);
  const level2 = specs("Sub\n---\n\nafter|");
  assert.equal(level2.lineClasses(1), "cm-lp-h2");
});

test("links show their text only, until the cursor touches them", () => {
  const away = specs('x|\n\n[text](http://example.com "title") and <http://auto.example>');
  assert.deepEqual(away.hidden, ["[", '](http://example.com "title")', "<", ">"]);
  assert.deepEqual(away.marked("cm-lp-link"), ["text", "http://auto.example"]);
  const inside = specs("see [te|xt](http://example.com) here");
  assert.deepEqual(inside.hidden, []);
  assert.deepEqual(inside.marked("cm-lp-link"), ["text"]);
  const inUrl = specs("see [text](http://exam|ple.com) here");
  assert.deepEqual(inUrl.hidden, []);
});

test("reference links, empty labels and bare addresses are left alone", () => {
  const s = specs("|[a][ref] and [b] and [](http://x.example) and http://bare.example/x");
  assert.deepEqual(s.hidden, []);
  assert.deepEqual(s.marked("cm-lp-link"), ["http://bare.example/x"]);
});

test("a link around an image: inner and outer reveal independently", () => {
  const away = specs("x|\n\n[![badge](b.png)](http://x.example)");
  assert.deepEqual(away.hidden, ["[", "](http://x.example)"]);
  assert.equal(away.widgets.length, 1);
  assert.equal(away.widgets[0].widget.type, "image");
  const on = specs("[![ba|dge](b.png)](http://x.example)");
  assert.deepEqual(on.hidden, [], "the cursor touches the link and the image");
});

test("images: replaced by a widget until the cursor touches the markup, which keeps the picture behind it", () => {
  const away = specs("|text ![alt text](pics/a.png) more");
  assert.equal(away.widgets.length, 1);
  const w = away.widgets[0];
  assert.equal(away.text.slice(w.from, w.to), "![alt text](pics/a.png)");
  assert.deepEqual(w.widget, { type: "image", alt: "alt text", src: "pics/a.png", editing: false });
  const near = specs("text ![alt text](pics/a.png)| more");
  assert.equal(near.widgets.length, 1);
  assert.equal(near.widgets[0].from, near.widgets[0].to);
  assert.equal(near.widgets[0].widget.editing, true);
  assert.deepEqual(near.hidden, []);
  const spaced = specs("|![a](<my pics/a b.png>)");
  assert.equal(spaced.widgets[0].widget.src, "my pics/a b.png");
});

test("bullets are drawn unless the cursor is at the marker, numbers stay", () => {
  const away = specs("|- one\n* two\n+ three\n  - nested\n1. first\n2) second");
  assert.deepEqual(
    away.widgets.map((w) => [away.text.slice(w.from, w.to), w.widget.type, w.widget.depth]),
    [["*", "bullet", 1], ["+", "bullet", 1], ["-", "bullet", 2]],
  );
  assert.equal(away.widgets.filter((w) => w.widget.type === "bullet").length, 3, "the first marker is touched by the cursor at 0");
  assert.deepEqual(away.marked("cm-lp-list-num"), ["1.", "2)"]);
  const text = specs("- on|e\n- two");
  assert.equal(text.widgets.filter((w) => w.widget.type === "bullet").length, 2);
  const marker = specs("-| one\n- two");
  assert.equal(marker.widgets.filter((w) => w.widget.type === "bullet").length, 1, "the cursor at the marker shows it");
  const after = specs("- |one\n- two");
  assert.equal(after.widgets.filter((w) => w.widget.type === "bullet").length, 1, "the cursor right behind the space too");
  const nested = specs("- a\n  - b\n    - c|");
  assert.deepEqual(nested.widgets.map((w) => w.widget.depth), [1, 2, 3]);
});

test("task items become checkboxes, which know where their brackets are", () => {
  const s = specs("|x\n\n- [ ] open\n- [x] done\n1. [X] numbered");
  assert.equal(s.widgets.length, 3);
  const [open, done, numbered] = s.widgets;
  assert.equal(s.text.slice(open.from, open.to), "- [ ]");
  assert.deepEqual(open.widget, { type: "checkbox", checked: false, offset: 2, editable: true });
  assert.equal(s.text.slice(done.from, done.to), "- [x]");
  assert.equal(done.widget.checked, true);
  assert.equal(s.text.slice(numbered.from, numbered.to), "[X]");
  assert.deepEqual(numbered.widget, { type: "checkbox", checked: true, offset: 0, editable: true });
  assert.deepEqual(s.marked("cm-lp-task-done"), [" done", " numbered"]);
  assert.deepEqual(s.marked("cm-lp-list-num"), ["1."]);
  const on = specs("x\n\n- [ ] op|en\n- [x] done");
  assert.equal(on.widgets.length, 2, "the cursor in the text of the item does not touch the box: it stays a checkbox");
  const at = specs("x\n\n- [ ]| open\n- [x] done");
  assert.equal(at.widgets.length, 1, "at the marker it is text again");
  const ro = specs("|x\n\n- [ ] open", { editable: false });
  assert.equal(ro.widgets[0].widget.editable, false);
});

test("blockquotes: marks hidden per line, every line gets the bar, nesting counted", () => {
  const away = specs("x|\n\n> one\n> two\n> > nested\n\nplain");
  assert.deepEqual(away.hidden, ["> ", "> ", "> ", "> "]);
  assert.equal(away.lineClasses(3), "cm-lp-quote cm-lp-quote-1");
  assert.equal(away.lineClasses(5), "cm-lp-quote cm-lp-quote-2");
  assert.equal(away.lineClasses(7), "");
  const on = specs("> one\n> t|wo\n> three");
  assert.deepEqual(on.hidden, ["> ", "> "]);
  const lazy = specs("|> one\ncontinued");
  assert.equal(lazy.lineClasses(2), "cm-lp-quote cm-lp-quote-1");
});

test("horizontal rules are drawn while the cursor is not on them", () => {
  const away = specs("|text\n\n---\n\n***\n\nmore");
  assert.deepEqual(away.widgets.map((w) => [away.text.slice(w.from, w.to), w.widget.type]), [["---", "hr"], ["***", "hr"]]);
  const on = specs("text\n\n--|-\n\nmore");
  assert.equal(on.widgets.length, 0);
});

test("fenced code: shaded lines, fences muted outside, normal inside; the code is left to the highlighter", () => {
  const doc = "|text\n\n```js\nlet a = **1**;\n```\n\nafter";
  const away = specs(doc);
  assert.equal(away.lineClasses(3), "cm-lp-codeblock cm-lp-codeblock-first cm-lp-fence");
  assert.equal(away.lineClasses(4), "cm-lp-codeblock");
  assert.equal(away.lineClasses(5), "cm-lp-codeblock cm-lp-codeblock-last cm-lp-fence");
  assert.deepEqual(away.hidden, [], "nothing inside code is hidden or styled");
  assert.deepEqual(away.marked("cm-lp-strong"), []);
  const inside = specs("text\n\n```js\nlet| a\n```\n\nafter");
  assert.equal(inside.lineClasses(3), "cm-lp-codeblock cm-lp-codeblock-first");
  assert.equal(inside.lineClasses(5), "cm-lp-codeblock cm-lp-codeblock-last");
  const open = specs("|```\ncode without end");
  assert.equal(open.lineClasses(2), "cm-lp-codeblock cm-lp-codeblock-last", "an unclosed fence has no closing line to mute");
});

test("indented code blocks are shaded", () => {
  const s = specs("|para\n\n    one\n    two\n\nafter");
  assert.equal(s.lineClasses(3), "cm-lp-codeblock cm-lp-codeblock-first");
  assert.equal(s.lineClasses(4), "cm-lp-codeblock cm-lp-codeblock-last");
});

test("backslash escapes hide the backslash while untouched", () => {
  const away = specs("|a \\* b \\_ c");
  assert.deepEqual(away.hidden, ["\\", "\\"]);
  const on = specs("a \\|* b");
  assert.deepEqual(on.hidden, []);
});

test("only the visible ranges are decorated", () => {
  const text = "|# One\n\n**a** b\n\n**c** d\n\n**e** f";
  const all = specs(text);
  const { text: plain } = parse(text);
  const from = plain.indexOf("**c**");
  const part = specs(text, { visible: [{ from, to: from + 8 }] });
  assert.deepEqual(part.hidden, ["**", "**"]);
  assert.equal(all.hidden.length, 6);
  // A code block that starts above the view is shaded where it is seen.
  const code = "|```\n" + "x\n".repeat(50) + "```";
  const mid = parse(code).text.indexOf("x\nx\nx");
  const view = specs(code, { visible: [{ from: mid, to: mid + 5 }] });
  assert.equal(view.list.filter((s) => s.kind === "line").length, 3);
});

test("a front matter block is not read as a rule and a heading", () => {
  const doc = "|---\ntitle: A *note*\ntags: [a]\n---\n\n# Real\n\n*it*";
  const s = specs(doc);
  assert.equal(frontMatterEnd(EditorState.create({ doc: parse(doc).text }).doc), parse(doc).text.indexOf("---\n\n# Real") + 3);
  assert.equal(s.widgets.length, 0);
  assert.equal(s.lineClasses(1), "");
  assert.equal(s.lineClasses(2), "");
  assert.equal(s.lineClasses(6), "cm-lp-h1");
  assert.deepEqual(s.hidden, ["# ", "*", "*"]);
  // Not a front matter: a rule on top, text after it.
  assert.equal(frontMatterEnd(EditorState.create({ doc: "---\njust text\n---\n" }).doc), -1);
  assert.equal(specs("---\n\nplain\n\n---\n\nx|").widgets.length, 2);
});

test("markup the parser does not know is left alone", () => {
  const s = specs("|plain text with 2 * 3 * 4 and a_b_c and a | b table-ish\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.deepEqual(s.hidden, []);
  assert.deepEqual(s.widgets, []);
});

test("specs come out sorted and never overlap hidden ranges", () => {
  const s = specs("|# T\n\n> **b** [l](u) ![i](p.png) `c` \\*\n\n- [x] *t*\n\n```\nc\n```\n");
  for (let i = 1; i < s.list.length; i++) assert.ok(s.list[i - 1].from <= s.list[i].from, "sorted by start");
  const replaced = s.list.filter((x) => x.kind === "hide" || (x.kind === "widget" && x.to > x.from));
  for (let i = 1; i < replaced.length; i++) assert.ok(replaced[i - 1].to <= replaced[i].from, "no overlap");
});
