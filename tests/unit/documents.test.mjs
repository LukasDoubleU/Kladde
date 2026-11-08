// Unit tests for the document viewer's pure parts: which files it takes, what the first bytes say, zoom and fit, and
// the CSS scan that keeps a document from reaching other resources:
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { referencesRemote, splitDeclarations } from "../../src/lib/css-scan.ts";
import {
  containerOf,
  documentFormat,
  fitScale,
  isDocumentPath,
  pageCountOf,
  problemFor,
  tooLargeProblem,
  zoomFactor,
} from "../../src/lib/documents.ts";

test("documents are recognized by extension, case-insensitively", () => {
  assert.ok(isDocumentPath("C:\\Users\\x\\Report.DOCX"));
  assert.ok(isDocumentPath("/home/x/a.b.docx"));
  assert.ok(!isDocumentPath("a.docm"));
  assert.ok(!isDocumentPath("a.doc"));
  assert.ok(!isDocumentPath("docx"));
  assert.ok(!isDocumentPath("C:\\dir.docx\\file.txt"));
  assert.equal(documentFormat("a.docx"), "Word document");
});

test("the container is told by the first bytes", () => {
  assert.equal(containerOf(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2])), "zip");
  assert.equal(containerOf(Uint8Array.from([0x50, 0x4b, 0x05, 0x06])), "zip");
  assert.equal(containerOf(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), "compound");
  assert.equal(containerOf(new TextEncoder().encode("hello")), "unknown");
  assert.equal(containerOf(new Uint8Array()), "unknown");
  assert.equal(problemFor("zip"), null);
  assert.equal(problemFor("compound").kind, "encrypted");
  assert.equal(problemFor("unknown").kind, "notDocument");
});

test("too large says the size and the limit", () => {
  const p = tooLargeProblem(63.2 * 1024 * 1024);
  assert.match(p.message, /63\.2 MB/);
  assert.match(p.message, /50 MB/);
});

test("zoom scales a document like the font size, and fit never enlarges", () => {
  assert.equal(zoomFactor(0, 14), 1);
  assert.ok(zoomFactor(3, 14) > 1);
  assert.ok(zoomFactor(-3, 14) < 1);
  assert.ok(zoomFactor(-100, 14) > 0);
  assert.equal(fitScale(1200, 794), 1);
  assert.equal(fitScale(397, 794), 0.5);
  assert.equal(fitScale(0, 794), 1);
});

test("data: addresses are allowed, every other address in a value is not", () => {
  assert.equal(referencesRemote("url(data:image/png;base64,AAAA)"), false);
  assert.equal(referencesRemote('url("data:image/png;base64,AAAA")'), false);
  assert.equal(referencesRemote("URL( 'DATA:image/png;base64,AAAA' )"), false);
  assert.equal(referencesRemote("url(https://example.com/a.png)"), true);
  assert.equal(referencesRemote('url("http://example.com/a.png")'), true);
  assert.equal(referencesRemote("url(//example.com/a.png)"), true);
  assert.equal(referencesRemote("url(a.png)"), true);
  assert.equal(referencesRemote("url(#clip)"), true);
  assert.equal(referencesRemote("url()"), true);
  assert.equal(referencesRemote("red"), false);
  assert.equal(referencesRemote("var(--docx-accent1-color)"), false);
  assert.equal(referencesRemote('"Times New Roman", serif'), false);
  assert.equal(referencesRemote("linear-gradient(red, blue)"), false);
});

test("escapes, comments and nesting do not hide an address", () => {
  assert.equal(referencesRemote("u\\72l(https://example.com/a.png)"), true);
  assert.equal(referencesRemote("\\75 rl(https://example.com/a.png)"), true);
  assert.equal(referencesRemote("ur\\l(https://example.com/a.png)"), true);
  assert.equal(referencesRemote("URL(https://example.com/a.png)"), true);
  assert.equal(referencesRemote("url(h\\74tps://example.com/a.png)"), true);
  assert.equal(referencesRemote('url("d\\61ta:image/png;base64,AAAA")'), false);
  assert.equal(referencesRemote("red /* url(x) */"), false);
  assert.equal(referencesRemote("url(/* c */https://example.com/a.png)"), true);
  assert.equal(referencesRemote("var(--a, url(https://example.com/a.png))"), true);
  assert.equal(referencesRemote("var(--a, url(data:image/png;base64,AAAA))"), false);
  assert.equal(referencesRemote("red, url(data:image/png;base64,AAAA), url(https://example.com/a.png)"), true);
  assert.equal(referencesRemote("cross-fade(url(data:image/png;base64,AAAA), url(https://example.com/a.png))"), true);
  assert.equal(referencesRemote("src(https://example.com/a.png)"), true);
});

test("strings are addresses inside image-set(), and text elsewhere", () => {
  assert.equal(referencesRemote('image-set("https://example.com/a.png" 1x)'), true);
  assert.equal(referencesRemote("-webkit-image-set('a.png' 1x)"), true);
  assert.equal(referencesRemote('image-set("data:image/png;base64,AAAA" 1x)'), false);
  assert.equal(referencesRemote("image-set(url(https://example.com/a.png) 1x)"), true);
  assert.equal(referencesRemote('"url(https://example.com/a.png)"'), false);
  assert.equal(referencesRemote("'it\\'s url(https://x)'"), false);
  assert.equal(referencesRemote('image-set("data:image/png;base64,AAAA" 1x), "https://example.com"'), false);
});

test("a function inside image-set() can bring in an address: var(), env(), attr() and anything unknown count as remote", () => {
  // `--k: "https://…"` and then `image-set(var(--k))`: the string becomes an address after the value is parsed.
  assert.equal(referencesRemote("image-set(var(--a) 1x)"), true);
  assert.equal(referencesRemote("image-set(var(--a))"), true);
  assert.equal(referencesRemote("-webkit-image-set(var(--a) 1x)"), true);
  assert.equal(referencesRemote("IMAGE-SET(VAR(--a))"), true);
  assert.equal(referencesRemote("image-set(v\\61r(--a))"), true);
  assert.equal(referencesRemote("image-set(env(a) 1x)"), true);
  assert.equal(referencesRemote("image-set(attr(title) 1x)"), true);
  assert.equal(referencesRemote("image-set(something(1) 1x)"), true);
  assert.equal(referencesRemote("image-set(url(data:image/png;base64,AAAA) 1x, var(--a) 2x)"), true);
  assert.equal(referencesRemote("image-set(calc(1) 1x)"), true);
  // What a document can legitimately put there stays.
  assert.equal(referencesRemote("image-set(url(data:image/png;base64,AAAA) 1x, url(data:image/png;base64,BBBB) 2x)"), false);
  assert.equal(referencesRemote("image-set(linear-gradient(red, blue) 1x)"), false);
  // After the closing parenthesis the value is judged as before.
  assert.equal(referencesRemote("image-set(url(data:image/png;base64,AAAA) 1x) var(--a)"), false);
});

test("a custom property is judged as if every string in it were an address", () => {
  assert.equal(referencesRemote('"https://example.com/a.png"', true), true);
  assert.equal(referencesRemote("'a.png'", true), true);
  assert.equal(referencesRemote('"Times New Roman"', true), true);
  assert.equal(referencesRemote('"d\\61ta:image/png;base64,AAAA"', true), false);
  assert.equal(referencesRemote("#1f2a44", true), false);
  assert.equal(referencesRemote("Calibri", true), false);
  assert.equal(referencesRemote("url(https://example.com/a.png)", true), true);
  assert.equal(referencesRemote("url(data:image/png;base64,AAAA)", true), false);
  // Only custom properties: anywhere else a string is text.
  assert.equal(referencesRemote('"https://example.com/a.png"'), false);
});

test("the page count is the file's own number, or none", () => {
  assert.equal(pageCountOf(12), 12);
  assert.equal(pageCountOf(1), 1);
  assert.equal(pageCountOf(0), null);
  assert.equal(pageCountOf(NaN), null);
  assert.equal(pageCountOf(undefined), null);
  assert.equal(pageCountOf("3"), null);
  assert.equal(pageCountOf(2.5), null);
  assert.equal(pageCountOf(10_000_000), null);
});

test("a declaration block is split at the semicolons outside strings and parentheses", () => {
  assert.deepEqual(splitDeclarations("color: red; background: url(data:image/png;base64,AAAA); font-family: 'a;b';"), [
    { name: "color", value: "red" },
    { name: "background", value: "url(data:image/png;base64,AAAA)" },
    { name: "font-family", value: "'a;b'" },
  ]);
  assert.deepEqual(splitDeclarations("width: 1px"), [{ name: "width", value: "1px" }]);
  assert.deepEqual(splitDeclarations(""), []);
  assert.deepEqual(splitDeclarations("--x: a\\;b; color: red"), [
    { name: "--x", value: "a\\;b" },
    { name: "color", value: "red" },
  ]);
});
