// Unit tests for the formatters. TypeScript sources are imported directly (Node strips the types):
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const load = (name) => import(pathToFileURL(resolve(import.meta.dirname, "../../src/lib", name)).href);
const { formatXml } = await load("format-xml.ts");
const { formatWith, formatterFor, mapCursor } = await load("formatters.ts");

const xml = (text) => formatXml(text, "  ");
const ok = (result) => {
  assert.ok("text" in result, "error" in result ? result.error : "");
  return result.text;
};

test("xml: re-indents elements and keeps attributes", () => {
  assert.equal(
    ok(xml('<?xml version="1.0"?><a x="1"  y = \'2\'><b/><c><d/></c></a>')),
    '<?xml version="1.0"?>\n<a x="1"  y = \'2\'>\n  <b/>\n  <c>\n    <d/>\n  </c>\n</a>',
  );
});

test("xml: keeps comments, CDATA, processing instructions and the doctype", () => {
  const input =
    '<!DOCTYPE note [<!ENTITY a "b>">]>\n<!-- top\n   comment -->\n<n><!-- c --><?pi data?><s><![CDATA[ <x> & ]]></s></n>';
  assert.equal(
    ok(xml(input)),
    '<!DOCTYPE note [<!ENTITY a "b>">]>\n<!-- top\n   comment -->\n<n>\n  <!-- c -->\n  <?pi data?>\n  <s><![CDATA[ <x> & ]]></s>\n</n>',
  );
});

test("xml: text and mixed content are copied verbatim", () => {
  const text = "<p>Hello   <b>big</b>\n   world</p>";
  assert.equal(ok(xml(`<doc>${text}<x>  keep  </x></doc>`)), `<doc>\n  ${text}\n  <x>  keep  </x>\n</doc>`);
});

test("xml: xml:space=preserve content is left alone", () => {
  const pre = '<pre xml:space="preserve">\n  <i>  a </i>\n</pre>';
  assert.equal(ok(xml(`<r>${pre}</r>`)), `<r>\n  ${pre}\n</r>`);
});

test("xml: empty elements and blank lines between groups", () => {
  assert.equal(ok(xml("<r>\n<a>\n</a>\n\n\n<b> </b><c/></r>")), "<r>\n  <a></a>\n\n  <b> </b>\n  <c/>\n</r>");
});

test("xml: multi-line attributes are re-indented", () => {
  assert.equal(
    ok(xml('<r><a\n        x="1"\n  y="2 3"\n   /></r>')),
    '<r>\n  <a\n    x="1"\n    y="2 3"\n  />\n</r>',
  );
});

test("xml: formatting twice changes nothing", () => {
  const once = ok(xml('<svg width="1"><g><path d="M0 0"/><text>a b</text></g><!-- x --></svg>'));
  assert.equal(ok(xml(once)), once);
});

test("xml: errors name line and column", () => {
  assert.match(xml("<a>\n  <b>\n</a>").error, /Expected <\/b> but found <\/a> \(line 3, column 1\)/);
  assert.match(xml("<a><b></a").error, /Unclosed tag/);
  assert.match(xml("<a>").error, /Unclosed <a> \(line 1, column 1\)/);
  assert.match(xml("<a><!-- x </a>").error, /Unclosed comment/);
  assert.match(xml("</a>").error, /Unexpected <\/a>/);
});

test("dispatch: language names map to formatters", () => {
  assert.deepEqual(formatterFor("JSON"), { kind: "json" });
  assert.deepEqual(formatterFor("XML"), { kind: "xml" });
  assert.deepEqual(formatterFor("MS SQL"), { kind: "sql", dialect: "transactsql" });
  assert.deepEqual(formatterFor("TSX"), { kind: "prettier", parser: "babel-ts" });
  assert.equal(formatterFor("Python"), null);
  assert.equal(formatterFor(null), null);
});

const options = { tabSize: 2, insertSpaces: true };

test("json: numbers and strings stay as written", async () => {
  const out = ok(await formatWith(formatterFor("JSON"), '{"a":1.0,"b":12345678901234567890,"c":"\u00e9"}', options));
  assert.equal(out, '{\n  "a": 1.0,\n  "b": 12345678901234567890,\n  "c": "\u00e9"\n}');
});

test("prettier: JavaScript, TypeScript, CSS, YAML, HTML, Markdown", async () => {
  const run = async (language, text, opts = options) => ok(await formatWith(formatterFor(language), text, opts));
  assert.equal(await run("JavaScript", "const a={b:1,c:[1,2]}"), "const a = { b: 1, c: [1, 2] };\n");
  assert.equal(await run("TypeScript", "let x:number=1"), "let x: number = 1;\n");
  assert.equal(await run("TSX", "const a=<div>{x as string}</div>"), "const a = <div>{x as string}</div>;\n");
  assert.equal(await run("CSS", "a{color:red;b:c}"), "a {\n  color: red;\n  b: c;\n}\n");
  assert.equal(await run("SCSS", "a{b{c:d}}"), "a {\n  b {\n    c: d;\n  }\n}\n");
  assert.equal(await run("YAML", "a:\n      - b\n      - c\n"), "a:\n  - b\n  - c\n");
  assert.equal(await run("HTML", "<div><p>x</p><script>let a=1</script></div>"), "<div>\n  <p>x</p>\n  <script>\n    let a = 1;\n  </script>\n</div>\n");
  assert.equal(await run("Markdown", "# T\n* a\n* b"), "# T\n\n- a\n- b\n");
});

test("prettier: tabs and the indent width follow the settings", async () => {
  assert.equal(ok(await formatWith(formatterFor("CSS"), "a{b:c}", { tabSize: 4, insertSpaces: false })), "a {\n\tb: c;\n}\n");
  assert.equal(ok(await formatWith(formatterFor("CSS"), "a{b:c}", { tabSize: 4, insertSpaces: true })), "a {\n    b: c;\n}\n");
});

test("prettier: errors carry line and column, shifted for a selection", async () => {
  const bad = await formatWith(formatterFor("JavaScript"), "let a = 1;\nlet = ;\n", options);
  assert.match(bad.error, /line 2, column \d+\)$/);
  const shifted = await formatWith(formatterFor("JavaScript"), "let a = 1;\nlet = ;\n", options, 10);
  assert.match(shifted.error, /line 11, column/);
});

test("sql: dialects", async () => {
  const out = ok(await formatWith(formatterFor("PostgreSQL"), "select a,b from t where x=1", options));
  assert.equal(out, "select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1");
});

test("cursor mapping keeps the place among the non-whitespace characters", () => {
  const before = "{a:1,b:2}";
  const after = "{\n  a: 1,\n  b: 2\n}";
  assert.equal(after.slice(0, mapCursor(before, after, 5)), "{\n  a: 1,");
  assert.equal(mapCursor(before, after, 0), 0);
  assert.equal(mapCursor(before, after, before.length), after.length);
  // At the start of an indented line it stays at the start of the (new) line.
  assert.equal(after.slice(0, mapCursor("{\n a: 1,\n b: 2\n}", after, 9)), "{\n  a: 1,\n");
});
