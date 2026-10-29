// Unit tests for the pure helpers of the large file view (caret movement, words, spans):
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { advance, charLeft, charRight, comparePos, flagSpans, leadingWhitespace, LINE_END, ordered, selectedLines, tabText, withCaret, wordAt, wordLeft, wordRight } =
  await import(pathToFileURL(resolve(import.meta.dirname, "../../src/lib/large-edit.ts")).href);

test("positions are ordered and advanced by inserted text", () => {
  assert.ok(comparePos({ line: 1, col: 9 }, { line: 2, col: 0 }) < 0);
  assert.deepEqual(ordered({ line: 3, col: 1 }, { line: 2, col: 7 }), [{ line: 2, col: 7 }, { line: 3, col: 1 }]);
  assert.deepEqual(advance({ line: 4, col: 2 }, "abc"), { line: 4, col: 5 });
  assert.deepEqual(advance({ line: 4, col: 2 }, "a\nbc\nde"), { line: 6, col: 2 });
  // The end of a shortened line stays "the end".
  assert.deepEqual(advance({ line: 4, col: LINE_END }, "ab"), { line: 4, col: LINE_END });
});

test("a surrogate pair is one character", () => {
  const text = "a😀b";
  assert.equal(charRight(text, 1), 3);
  assert.equal(charLeft(text, 3), 1);
  assert.equal(charLeft(text, 1), 0);
  assert.equal(charRight(text, 4), 4);
  assert.equal(charLeft(text, 0), 0);
});

test("word movement skips spaces and keeps classes together", () => {
  const text = "foo  bar_baz, (x)";
  assert.equal(wordRight(text, 0), 3);
  assert.equal(wordRight(text, 3), 12);
  assert.equal(wordRight(text, 12), 13);
  assert.equal(wordLeft(text, 12), 5);
  assert.equal(wordLeft(text, 5), 0);
  assert.equal(wordLeft(text, 0), 0);
  assert.equal(wordRight(text, text.length), text.length);
  assert.deepEqual(wordAt(text, 1), [0, 3]);
  assert.deepEqual(wordAt(text, 3), [3, 5]);
  // Past the end: the last character's run.
  assert.deepEqual(wordAt(text, 99), [16, 17]);
  assert.deepEqual(wordAt("", 0), [0, 0]);
  assert.equal(wordRight("über Größe", 0), 4);
});

test("indentation and tab stops", () => {
  assert.equal(leadingWhitespace("\t  text"), "\t  ");
  assert.equal(leadingWhitespace("text"), "");
  assert.equal(tabText(0, 4, true), "    ");
  assert.equal(tabText(3, 4, true), " ");
  assert.equal(tabText(5, 4, false), "\t");
});

test("line commands ignore a last line the selection only touches", () => {
  const at = (line, col) => ({ line, col });
  assert.deepEqual(selectedLines(at(2, 3), at(2, 3)), { first: 2, last: 2 });
  assert.deepEqual(selectedLines(at(2, 3), at(4, 0)), { first: 2, last: 3 });
  assert.deepEqual(selectedLines(at(4, 2), at(2, 3)), { first: 2, last: 4 });
});

test("spans are split for selection, match and caret without changing the text", () => {
  const spans = [
    { text: "let ", cls: "kw" },
    { text: "value", cls: "" },
  ];
  const marked = flagSpans(spans, 2, 6, "sel");
  assert.equal(marked.map((s) => s.text).join(""), "let value");
  assert.deepEqual(
    marked.filter((s) => s.sel).map((s) => [s.text, s.cls]),
    [
      ["t ", "kw"],
      ["va", ""],
    ],
  );
  const caret = withCaret(marked, 4);
  assert.equal(caret.filter((s) => s.caret).length, 1);
  assert.equal(caret.map((s) => s.text).join(""), "let value");
  // The caret at the end of the line (or past it) still gets drawn.
  assert.equal(withCaret(spans, 99).at(-1).caret, true);
  assert.equal(withCaret([], 0).length, 1);
});
