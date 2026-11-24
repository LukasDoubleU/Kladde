// Math (KaTeX) and Mermaid diagrams in Live Preview: drawn while the cursor is elsewhere, the source shows (with the
// drawing below it) while it is inside, a click puts the cursor into the source, the tab stays clean, and the diagrams
// follow the theme. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
//
// Mouse and key events go into the page through DevTools, never to the desktop.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile } from "./kladde.mjs";

const profile = tempProfile("kladde-livemath");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC = [
  "# Formulas", //                                                         1
  "", //                                                                   2
  "Euler: $e^{i\\pi} + 1 = 0$ and money: $5 and $6 stay text.", //          3
  "", //                                                                   4
  "$$", //                                                                 5
  "\\begin{aligned}", //                                                   6
  "a &= b + c \\\\", //                                                    7
  "d &= e + f", //                                                         8
  "\\end{aligned}", //                                                     9
  "$$", //                                                                 10
  "", //                                                                   11
  "```mermaid", //                                                         12
  "flowchart LR", //                                                       13
  "  A[Start] --> B[Finish]", //                                           14
  "```", //                                                                15
  "", //                                                                   16
  "```mermaid", //                                                         17
  "flowchart LR", //                                                       18
  "  A --> ???[", //                                                       19
  "```", //                                                                20
  "", //                                                                   21
  "A bad formula $\\foo{x}$ and code `$a$` and \\$b$ here.", //            22
  "", //                                                                   23
  "The end", //                                                            24
  "", //                                                                   25
].join("\n");

const view = "document.querySelector('.cm-content').cmTile.view";
const docText = (app) => app.eval(`${view}.state.doc.toString()`);
const tabClean = (app) => app.eval("!document.querySelector('.tab.active.dirty')");
const lineOf = (app, needle) =>
  app.eval(`[...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(${JSON.stringify(needle)}))?.textContent ?? null`);
const count = (app, selector) => app.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

const cursorAt = (app, needle, delta = 0) =>
  app.eval(`(() => {
    const view = ${view};
    const at = view.state.doc.toString().indexOf(${JSON.stringify(needle)}) + ${delta};
    view.dispatch({ selection: { anchor: at } });
    return at;
  })()`);

const centerOf = (app, selector) =>
  app.eval(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  })()`);

async function click(app, point) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await app.cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  }
  await sleep(200);
}

test("formulas and diagrams are drawn, their source shows where the cursor is, and nothing changes the text", async () => {
  const dir = tempProfile("kladde-livemath-run");
  mkdirSync(join(dir, "data"), { recursive: true });
  const settings = join(dir, "data", "settings.json");
  writeFileSync(settings, JSON.stringify({ markdownPreview: "off", theme: "mocha" }));
  mkdirSync(join(dir, "files"), { recursive: true });
  const path = join(dir, "files", "math.md");
  writeFileSync(path, DOC);
  const app = await launch({ port: 9471, profile: dir, files: [path] });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'math.md'", 15000);
    await app.waitFor("!!document.querySelector('.cm-editor.cm-live-preview')", 10000);
    await app.eval(`${view}.focus(), true`);
    await cursorAt(app, "The end");

    // Inline and display formulas: KaTeX output, the source is not in the text; money stays text.
    await app.waitFor("!!document.querySelector('.cm-line .cm-lp-math .katex')", 15000);
    await app.waitFor("!!document.querySelector('.cm-lp-math-block .katex')", 15000);
    assert.equal(await count(app, ".cm-lp-math-block .katex-display"), 1, "display math is a block");
    assert.match(await lineOf(app, "Euler:"), /^Euler: .* and money: \$5 and \$6 stay text\.$/);
    assert.equal((await lineOf(app, "Euler:")).includes("$e^"), false, "the TeX source of the formula is not shown");
    assert.equal(await lineOf(app, "\\begin{aligned}"), null, "nor the source of the block");
    // A formula KaTeX rejects shows its source as in the preview; code and escaped dollars stay text.
    assert.equal(await count(app, ".cm-lp-math.math-error"), 1);
    assert.equal(await app.eval("document.querySelector('.cm-lp-math.math-error').textContent"), "\\foo{x}");
    assert.match(await app.eval("document.querySelector('.cm-lp-math.math-error').title"), /\w/);
    assert.match(await lineOf(app, "A bad formula"), /code \$a\$ and \$b\$ here\.$/, "(the backslash of the escape is hidden)");

    // Diagrams: an SVG for the good one, the preview's error box for the broken one.
    await app.waitFor("!!document.querySelector('.cm-lp-diagram svg')", 40000);
    await app.waitFor("!!document.querySelector('.cm-lp-diagram .mermaid-error')", 40000);
    assert.equal(await lineOf(app, "flowchart LR"), null, "no diagram source while drawn");
    assert.equal(await app.eval("document.querySelector('.cm-lp-diagram .mermaid-error strong').textContent"), "Diagram error");

    const text = await docText(app);
    assert.equal(text, DOC);
    assert.equal(await tabClean(app), true);

    // The cursor in the inline formula: its source shows, the drawing of that one goes.
    const inlineCount = await count(app, ".cm-line .cm-lp-math");
    await cursorAt(app, "i\\pi", 1);
    assert.match(await lineOf(app, "Euler:"), /Euler: \$e\^\{i\\pi\} \+ 1 = 0\$ and money/);
    assert.equal(await count(app, ".cm-line .cm-lp-math"), inlineCount - 1);

    // The cursor in the display block: the source shows, shaded, and the drawing stays below it.
    await cursorAt(app, "a &= b", 2);
    assert.equal(await lineOf(app, "\\begin{aligned}"), "\\begin{aligned}");
    assert.equal(await count(app, ".cm-lp-mathsrc"), 6);
    await app.waitFor("!!document.querySelector('.cm-lp-math-block.cm-lp-below .katex')");

    // The cursor in a diagram: its source shows and the drawing stays below.
    await cursorAt(app, "A[Start]", 3);
    assert.equal(await lineOf(app, "A[Start] --> B[Finish]"), "  A[Start] --> B[Finish]");
    await app.waitFor("!!document.querySelector('.cm-lp-diagram.cm-lp-below svg')", 20000);
    assert.equal(await tabClean(app), true, "the tab stays clean");
    assert.equal(await docText(app), DOC);

    // A click on a drawn formula puts the cursor into its source, which then shows.
    await cursorAt(app, "The end");
    await app.waitFor("!!document.querySelector('.cm-line .cm-lp-math .katex')");
    await click(app, await centerOf(app, ".cm-line .cm-lp-math .katex"));
    assert.match(await lineOf(app, "Euler:"), /\$e\^\{i\\pi\} \+ 1 = 0\$/);
    await cursorAt(app, "The end");
    // And a click on the drawn block does too.
    await click(app, await centerOf(app, ".cm-lp-math-block .katex"));
    await app.waitFor(`[...document.querySelectorAll('.cm-line')].some((l) => l.textContent === '\\\\begin{aligned}')`);
    assert.equal(await tabClean(app), true);

    // Ctrl+E shows the plain source everywhere and back again; undo has nothing to take back.
    await cursorAt(app, "The end");
    await app.eval(`${view}.focus(), true`);
    await app.key("Ctrl+E");
    await app.waitFor("!document.querySelector('.cm-editor.cm-live-preview')");
    assert.equal(await count(app, ".cm-lp-math, .cm-lp-diagram"), 0);
    assert.match(await lineOf(app, "Euler:"), /\$e\^\{i\\pi\} \+ 1 = 0\$/);
    await app.key("Ctrl+E");
    await app.waitFor("!!document.querySelector('.cm-lp-diagram svg')", 20000);
    assert.equal(await docText(app), DOC);
    assert.equal(await tabClean(app), true);

    // A theme change draws the diagrams again, in the new colors.
    // (theme.test covers the real switch of flavors; here the variables the diagrams read change and the event that every
    // theme change sends is dispatched.)
    assert.equal(await app.eval("document.querySelector('.cm-lp-diagram svg').outerHTML.toLowerCase().includes('#ddeeff')"), false);
    await app.eval(`(() => {
      document.documentElement.style.setProperty('--bg-hover', '#ddeeff');
      window.dispatchEvent(new Event('kladde-theme'));
    })()`);
    await app.waitFor("document.querySelector('.cm-lp-diagram svg')?.outerHTML.toLowerCase().includes('#ddeeff')", 30000);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});
