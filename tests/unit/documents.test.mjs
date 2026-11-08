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
  FRAME_CSP,
  FRAME_HOST_ID,
  FRAME_SANDBOX,
  FRAME_VARIABLES,
  frameSrcdoc,
  isDocumentPath,
  isSelectAll,
  keyboardInit,
  makeH,
  mouseInit,
  pageCountOf,
  problemFor,
  tooLargeProblem,
  wheelInit,
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

// ------------------------------------------------------------------------------------------------ the frame

/** A CSP as a map of directive to sources. */
function directives(policy) {
  return Object.fromEntries(policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...sources] = d.split(/\s+/); return [name, sources]; }));
}

test("the frame's policy denies everything but data: images and fonts and inline styles", () => {
  const csp = directives(FRAME_CSP);
  assert.deepEqual(csp["default-src"], ["'none'"]);
  assert.deepEqual(csp["img-src"], ["data:"]);
  assert.deepEqual(csp["font-src"], ["data:"]);
  assert.deepEqual(csp["style-src"], ["'unsafe-inline'"]);
  // Not covered by default-src, so named.
  assert.deepEqual(csp["base-uri"], ["'none'"]);
  assert.deepEqual(csp["form-action"], ["'none'"]);
  // No script, no connection, no frame, no other address of any kind.
  for (const name of ["script-src", "connect-src", "frame-src", "object-src", "media-src"]) assert.equal(csp[name], undefined, `${name} falls back to 'none'`);
  assert.doesNotMatch(FRAME_CSP, /https?:|\*|'self'|blob:|'unsafe-eval'/);
});

test("the frame's document starts with its policy, before anything that could load something", () => {
  const html = frameSrcdoc();
  const policy = html.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(policy > 0);
  assert.ok(html.includes(`content="${FRAME_CSP}"`));
  // Next to it: no background DNS lookups for the hosts of links.
  const dns = html.indexOf('http-equiv="x-dns-prefetch-control" content="off"');
  assert.ok(dns > policy && dns < html.indexOf("<style"));
  for (const later of ["<style", "<body", "<link", "<img", "<script", "<iframe", "<div"]) assert.ok(html.indexOf(later) === -1 || html.indexOf(later) > policy, later);
  // Nothing in it can fetch anything or run: no scripts, links, frames, images, imports or addresses.
  assert.doesNotMatch(html, /<script|<link|<iframe|<img|@import|url\(|https?:/i);
  assert.ok(html.includes(`id="${FRAME_HOST_ID}"`));
  // The attribute value is quoted by double quotes: the policy must not contain one.
  assert.ok(!FRAME_CSP.includes('"'));
});

test("the sandbox keeps only the origin, and the theme variables are the ones the frame's CSS reads", () => {
  assert.equal(FRAME_SANDBOX, "allow-same-origin");
  const css = frameSrcdoc();
  for (const name of FRAME_VARIABLES) assert.match(name, /^--[a-z-]+$/);
  // Every variable the frame's own CSS reads is passed in (the overrides are checked in the e2e test).
  for (const used of css.matchAll(/var\((--[a-z-]+)\)/g)) assert.ok(FRAME_VARIABLES.includes(used[1]), used[1]);
});

const keydown = (init) => ({ key: "a", code: "KeyA", location: 0, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, getModifierState: () => false, ...init });

test("a key of the frame is copied with everything the shortcut handling reads", () => {
  const init = keyboardInit(keydown({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, repeat: true }));
  assert.deepEqual(
    { key: init.key, code: init.code, ctrl: init.ctrlKey, shift: init.shiftKey, alt: init.altKey, meta: init.metaKey, repeat: init.repeat },
    { key: "P", code: "KeyP", ctrl: true, shift: true, alt: false, meta: false, repeat: true },
  );
  // Cancelable (the page's answer decides the original's fate), bubbling to the window's listeners.
  assert.equal(init.cancelable, true);
  assert.equal(init.bubbles, true);
  // AltGr (Ctrl+Alt that types a character) must stay recognizable.
  assert.equal(keyboardInit(keydown({ ctrlKey: true, altKey: true, getModifierState: (m) => m === "AltGraph" })).modifierAltGraph, true);
  assert.equal(keyboardInit(keydown({ ctrlKey: true, altKey: true })).modifierAltGraph, false);
  // An event without getModifierState (a stand-in) is not AltGr.
  assert.equal(keyboardInit({ ...keydown({}), getModifierState: undefined }).modifierAltGraph, false);
});

test("wheel and mouse events of the frame land where the pointer is in the window", () => {
  const box = { left: 0, top: 36 };
  const wheel = wheelInit({ deltaX: 0, deltaY: -120, deltaZ: 0, deltaMode: 0, clientX: 500, clientY: 300, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, box);
  assert.deepEqual([wheel.clientX, wheel.clientY, wheel.deltaY, wheel.ctrlKey, wheel.cancelable], [500, 336, -120, true, true]);
  const mouse = mouseInit({ button: 3, buttons: 8, clientX: 10, clientY: 20, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, { left: 5, top: 36 });
  assert.deepEqual([mouse.button, mouse.buttons, mouse.clientX, mouse.clientY, mouse.cancelable], [3, 8, 15, 56, true]);
});

test("only Ctrl+A on its own selects the document", () => {
  const key = (init) => isSelectAll({ key: "a", ctrlKey: true, shiftKey: false, altKey: false, ...init });
  assert.equal(key({}), true);
  assert.equal(key({ key: "A" }), true);
  assert.equal(key({ ctrlKey: false }), false);
  assert.equal(key({ shiftKey: true }), false);
  assert.equal(key({ altKey: true }), false);
  assert.equal(key({ key: "b" }), false);
});

// A document of a few methods, enough to see which one made which node and what was set on it.
function fakeDocument(label) {
  const node = (props) => ({ owner: label, children: [], appendChild(c) { this.children.push(c); return c; }, ...props });
  return {
    createTextNode: (text) => node({ nodeType: 3, text }),
    createComment: (text) => node({ nodeType: 8, text }),
    createDocumentFragment: () => node({ nodeType: 11 }),
    createElement: (tag) => node({ nodeType: 1, tag, ns: null, attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
    createElementNS: (ns, tag) => node({ nodeType: 1, tag, ns, attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
  };
}

test("the engine's nodes are all made by the document it is given", () => {
  const h = makeH(fakeDocument("frame"));
  const ready = h({ tagName: "p", children: ["text"] });
  const tree = h({
    tagName: "section",
    className: "docx",
    style: { color: "red" },
    id: "a",
    title: undefined,
    children: [
      "hello",
      { tagName: "#comment", children: ["note"] },
      { tagName: "#fragment", children: ["in a fragment", { tagName: "svg", ns: "http://www.w3.org/2000/svg", style: "fill:red", children: [{ tagName: "image", href: "data:image/png;base64,AA==" }] }] },
      ready,
    ],
  });
  const owners = new Set();
  const walk = (n) => (owners.add(n.owner), n.children.forEach(walk));
  walk(tree);
  assert.deepEqual([...owners], ["frame"], "nothing is made by another document");
  assert.equal(tree.tag, "section");
  assert.equal(tree.attrs.class, "docx");
  assert.equal(tree.style.color, "red");
  assert.equal(tree.id, "a");
  assert.ok(!("title" in tree), "an undefined property is not set");
  const [text, comment, fragment, same] = tree.children;
  assert.equal(text.text, "hello");
  assert.equal(comment.nodeType, 8);
  assert.equal(comment.text, "note");
  assert.equal(fragment.nodeType, 11);
  assert.equal(fragment.children[0].text, "in a fragment");
  const svg = fragment.children[1];
  assert.equal(svg.ns, "http://www.w3.org/2000/svg");
  assert.equal(svg.attrs.style, "fill:red", "a style given as text is an attribute");
  assert.equal(svg.children[0].href, "data:image/png;base64,AA==");
  // A node that is already made passes through, whatever its class.
  assert.equal(same, ready);
  // Another document, another owner.
  assert.equal(makeH(fakeDocument("page"))("x").owner, "page");
});
