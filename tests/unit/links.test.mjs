// Unit tests for finding links in a line, what an href means and the heading anchors:
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { classifyHref, createSlugger, findUrls, headingAnchors, linkAt, resolvePath, dirname } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../src/lib/links.ts")).href
);

/** The hrefs of all URLs found in a line. */
const urls = (text) => findUrls(text).map((l) => l.href);

test("a URL ends at white space and at characters that cannot be part of it", () => {
  assert.deepEqual(urls("see https://example.com/a?b=1#c now"), ["https://example.com/a?b=1#c"]);
  assert.deepEqual(urls('{"url":"https://example.com/x","n":1}'), ["https://example.com/x"]);
  assert.deepEqual(urls("<https://example.com/x> and `http://a.org/y`"), ["https://example.com/x", "http://a.org/y"]);
  assert.deepEqual(urls("one http://a.io two https://b.io"), ["http://a.io", "https://b.io"]);
  assert.deepEqual(urls("HTTPS://EXAMPLE.COM/Path"), ["HTTPS://EXAMPLE.COM/Path"]);
  assert.deepEqual(urls("http://localhost:8080/x http://[::1]:3000/y"), ["http://localhost:8080/x", "http://[::1]:3000/y"]);
});

test("a URL is found by its offsets", () => {
  const [link] = findUrls("go to https://example.com/x, then");
  assert.equal(link.from, 6);
  assert.equal(link.to, 6 + "https://example.com/x".length);
});

test("punctuation after a URL belongs to the sentence", () => {
  assert.deepEqual(urls("Visit https://example.com."), ["https://example.com"]);
  assert.deepEqual(urls("a https://example.com/a, b"), ["https://example.com/a"]);
  assert.deepEqual(urls("really https://example.com/a?!"), ["https://example.com/a"]);
  assert.deepEqual(urls("(see https://example.com/a)"), ["https://example.com/a"]);
  assert.deepEqual(urls("[https://example.com/a]"), ["https://example.com/a"]);
  assert.deepEqual(urls("'https://example.com/a'"), ["https://example.com/a"]);
  assert.deepEqual(urls("**https://example.com/a**"), ["https://example.com/a"]);
  assert.deepEqual(urls("at https://example.com/a: yes"), ["https://example.com/a"]);
  assert.deepEqual(urls("\u201chttps://example.com/a\u201d"), ["https://example.com/a"]);
});

test("balanced brackets stay in the URL", () => {
  assert.deepEqual(urls("https://en.wikipedia.org/wiki/Rust_(language)"), ["https://en.wikipedia.org/wiki/Rust_(language)"]);
  assert.deepEqual(urls("(https://en.wikipedia.org/wiki/Rust_(language))"), ["https://en.wikipedia.org/wiki/Rust_(language)"]);
  assert.deepEqual(urls("https://example.com/a(b))."), ["https://example.com/a(b)"]);
  assert.deepEqual(urls("[a](https://example.com/a)"), ["https://example.com/a"]);
});

test("mailto links need an address", () => {
  assert.deepEqual(urls("write to mailto:me@example.com."), ["mailto:me@example.com"]);
  assert.deepEqual(urls("mailto:me@example.com?subject=Hi%20there"), ["mailto:me@example.com?subject=Hi%20there"]);
  assert.deepEqual(urls("mailto: nobody and mailto:nobody"), []);
});

test("only http, https and mailto are found, and not inside a word", () => {
  assert.deepEqual(urls("file:///C:/Windows/notepad.exe javascript:void(0) ftp://example.com data:text/html,x"), []);
  assert.deepEqual(urls("xhttp://example.com ahttps://example.com"), []);
  assert.deepEqual(urls("http:// https:/// http://. https://"), []);
  assert.deepEqual(urls("see\\nhttps://example.com\\n"), ["https://example.com"]);
  assert.deepEqual(urls("url=https://example.com/a?b=c&d=e"), ["https://example.com/a?b=c&d=e"]);
});

test("a very long line is searched around the position only", () => {
  const filler = "x ".repeat(30000);
  const line = `${filler}https://example.com/deep ${filler}`;
  const at = filler.length + 4;
  assert.equal(linkAt(line, at, false)?.href, "https://example.com/deep");
  assert.equal(linkAt(line, 5, false), null);
});

test("the link at an offset: URLs", () => {
  const text = "a https://example.com/x b";
  assert.equal(linkAt(text, 1, false), null);
  assert.equal(linkAt(text, 2, false)?.href, "https://example.com/x", "start of the URL");
  assert.equal(linkAt(text, 10, false)?.href, "https://example.com/x");
  assert.equal(linkAt(text, 23, false)?.href, "https://example.com/x", "right after the URL");
  assert.equal(linkAt(text, 24, false), null);
});

test("the link at an offset: Markdown links and images", () => {
  const text = "x [the docs](https://example.com/docs) y";
  assert.equal(linkAt(text, 3, true)?.href, "https://example.com/docs", "text");
  assert.equal(linkAt(text, 14, true)?.href, "https://example.com/docs", "target");
  assert.equal(linkAt(text, 2, true)?.href, "https://example.com/docs", "opening bracket");
  assert.equal(linkAt(text, 38, true)?.href, "https://example.com/docs", "after the closing parenthesis");
  assert.equal(linkAt(text, 1, true), null, "before");
  assert.equal(linkAt(text, 40, true), null, "after");
  assert.deepEqual(linkAt(text, 5, true), { from: 2, to: 38, href: "https://example.com/docs" });

  const image = "![alt text](img/a.png)";
  assert.equal(linkAt(image, 0, true)?.from, 0, "an image starts at its !");
  assert.equal(linkAt(image, 4, true)?.href, "img/a.png");
});

test("Markdown link targets: spaces, titles, parentheses, escapes", () => {
  assert.equal(linkAt("[a](<my file.md>)", 1, true)?.href, "my file.md");
  assert.equal(linkAt('[a](page.md "The title")', 1, true)?.href, "page.md");
  assert.equal(linkAt("[a](page.md 'The title')", 1, true)?.href, "page.md");
  assert.equal(linkAt("[a](page.md (The title))", 1, true)?.href, "page.md");
  assert.equal(linkAt("[a](https://en.wikipedia.org/wiki/A_(b))", 1, true)?.href, "https://en.wikipedia.org/wiki/A_(b)");
  assert.equal(linkAt("[a](page\\(1\\).md)", 1, true)?.href, "page(1).md");
  assert.equal(linkAt("[a](#intro)", 1, true)?.href, "#intro");
  assert.equal(linkAt("[a]()", 1, true)?.href, "");
  assert.equal(linkAt("[a](page.md", 1, true), null, "unclosed");
  assert.equal(linkAt("a](page.md)", 3, true), null, "no opening bracket");
  assert.equal(linkAt("\\[a\\](page.md)", 5, true), null, "escaped brackets");
  assert.equal(linkAt("[a] (page.md)", 1, true), null, "no space allowed before the target");
});

test("nested Markdown links: a badge opens the page from its text and the image from its target", () => {
  const text = "[![Build](https://img.example/b.svg)](https://ci.example/run)";
  assert.equal(linkAt(text, 5, true)?.href, "https://ci.example/run", "alt text");
  assert.equal(linkAt(text, 1, true)?.href, "https://ci.example/run", "image mark");
  assert.equal(linkAt(text, 20, true)?.href, "https://img.example/b.svg", "image target");
  assert.equal(linkAt(text, 50, true)?.href, "https://ci.example/run", "page target");
  assert.equal(linkAt("[a [b] c](x.md)", 4, true)?.href, "x.md", "balanced brackets in the text");
});

test("autolinks and bare URLs in Markdown", () => {
  assert.equal(linkAt("see <https://example.com/x> ok", 12, true)?.href, "https://example.com/x");
  assert.equal(linkAt("mail <mailto:me@example.com>", 12, true)?.href, "mailto:me@example.com");
  assert.equal(linkAt("plain https://example.com/x.", 10, true)?.href, "https://example.com/x");
  // The Markdown form wins where both match.
  assert.equal(linkAt("[https://a.example](https://b.example)", 5, true)?.href, "https://b.example");
});

test("Markdown syntax is only a link in Markdown", () => {
  assert.equal(linkAt("[a](page.md)", 1, false), null);
  assert.equal(linkAt("[a](https://example.com/x)", 1, false), null, "the text is not the URL");
  assert.equal(linkAt("[a](https://example.com/x)", 6, false)?.href, "https://example.com/x");
});

test("an href means a browser, a heading, a file or nothing", () => {
  assert.deepEqual(classifyHref("https://example.com/a?b#c"), { kind: "external", url: "https://example.com/a?b#c" });
  assert.deepEqual(classifyHref("HTTP://example.com"), { kind: "external", url: "HTTP://example.com" });
  assert.deepEqual(classifyHref("mailto:me@example.com"), { kind: "external", url: "mailto:me@example.com" });
  assert.deepEqual(classifyHref("#my-heading"), { kind: "anchor", id: "my-heading" });
  assert.deepEqual(classifyHref("#gr%C3%BCn"), { kind: "anchor", id: "gr\u00fcn" });
  assert.deepEqual(classifyHref("notes.md"), { kind: "file", path: "notes.md" });
  assert.deepEqual(classifyHref("../docs/a%20b.md?x=1#top"), { kind: "file", path: "../docs/a b.md" });
  assert.deepEqual(classifyHref("sub/dir/x.txt"), { kind: "file", path: "sub/dir/x.txt" });
  assert.deepEqual(classifyHref("C:\\notes\\a.md"), { kind: "file", path: "C:\\notes\\a.md" });
  assert.deepEqual(classifyHref("C:/notes/a.md"), { kind: "file", path: "C:/notes/a.md" });
  assert.deepEqual(classifyHref("100%.md"), { kind: "file", path: "100%.md" }, "malformed escapes stay as they are");
});

test("other schemes and network paths are never opened", () => {
  for (const href of [
    "file:///C:/Windows/notepad.exe",
    "FILE:///C:/x",
    "javascript:void(0)",
    "JavaScript:void(0)",
    "data:text/html,<b>x</b>",
    "vbscript:x",
    "ftp://example.com/x",
    "foo-app:open",
    "steam://run/1",
    "tel:123",
    "\\\\server\\share\\x.md",
    "//server/share/x.md",
    "C:foo.md",
    "a.md:stream",
    "dir/a:b.md",
    "",
    "#",
    "   ",
    "?query",
  ]) {
    assert.equal(classifyHref(href), null, href);
  }
});

test("paths resolve against the folder of the file", () => {
  assert.equal(resolvePath("C:\\notes", "a.md"), "C:\\notes\\a.md");
  assert.equal(resolvePath("C:\\notes\\sub", "../b.md"), "C:\\notes\\b.md");
  assert.equal(resolvePath("C:\\notes", "./x/./y.md"), "C:\\notes\\x\\y.md");
  assert.equal(resolvePath("C:\\notes", "D:/other/z.md"), "D:\\other\\z.md");
  assert.equal(dirname("C:\\notes\\a.md"), "C:\\notes");
});

test("heading anchors follow the slug rule of the preview", () => {
  const slug = createSlugger();
  assert.equal(slug("Hello, World!"), "hello-world");
  assert.equal(slug("Hello World"), "hello-world-1", "a repeated title gets a number");
  assert.equal(slug("  Gr\u00fcn & Gold  "), "gr\u00fcn--gold");
  assert.equal(slug("**Bold** `code`"), "bold-code");

  const anchors = headingAnchors(
    [
      "# Title",
      "",
      "Intro",
      "",
      "## Install it",
      "```sh",
      "# not a heading",
      "```",
      "### Install it",
      "Setext one",
      "==========",
      "",
      "Two line",
      "setext",
      "------",
      "",
      "---",
      "####### seven hashes",
      "#NoSpace",
      "## Closed ##",
      "#",
      "    # indented code",
      "~~~~",
      "## in tildes",
      "~~~~",
      "- item",
      "---",
    ].values(),
  );
  assert.deepEqual(
    [...anchors],
    [
      ["title", 0],
      ["install-it", 4],
      ["install-it-1", 8],
      ["setext-one", 9],
      ["two-line-setext", 12],
      ["closed", 19],
      ["", 20],
    ],
  );
});
