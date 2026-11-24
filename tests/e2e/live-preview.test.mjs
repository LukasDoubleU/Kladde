// Live Preview of Markdown in the editor: markup hidden until the cursor touches it, Ctrl+E to Source and back,
// task boxes, links, images, the session and the language switch. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
//
// Mouse and key events go into the page through DevTools, never to the desktop. External links are not opened:
// KLADDE_OPEN_URL_LOG (isolated profile only) makes Kladde write the URL it would have opened into a file.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-livepreview");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1x1 PNG: the image widget only has to load something from next to the document.
const DOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const DOC = [
  "# Title heading", //                                                          1
  "", //                                                                         2
  "Plain **bold text** and *italic* and [the docs](https://example.com/docs).", // 3
  "", //                                                                         4
  "- [ ] open task", //                                                          5
  "- [x] done task", //                                                          6
  "- plain bullet", //                                                           7
  "", //                                                                         8
  "![pic](pics/dot.png)", //                                                     9
  "", //                                                                         10
  "> quoted words", //                                                           11
  "", //                                                                         12
  "The end", //                                                                  13
  "", //                                                                         14
].join("\n");

const view = "document.querySelector('.cm-content').cmTile.view";
const docText = (app) => app.eval(`${view}.state.doc.toString()`);
const tabClean = (app) => app.eval("!document.querySelector('.tab.active.dirty')");
const lineOf = (app, needle) =>
  app.eval(`[...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(${JSON.stringify(needle)}))?.textContent ?? null`);
const live = (app) => app.eval("!!document.querySelector('.cm-editor.cm-live-preview')");
const modeButton = (app) =>
  app.eval(`[...document.querySelectorAll('footer button')].map((b) => b.textContent.trim()).find((t) => t === 'Live Preview' || t === 'Source') ?? null`);
const position = (app) => app.eval("document.querySelector('footer').innerText.match(/Ln (\\d+), Col (\\d+)/)?.slice(1).join(':')");

/** Puts the cursor in the document at the first `needle` plus `delta` (a selection change, no mouse). */
const cursorAt = (app, needle, delta = 0) =>
  app.eval(`(() => {
    const view = ${view};
    const at = view.state.doc.toString().indexOf(${JSON.stringify(needle)}) + ${delta};
    view.dispatch({ selection: { anchor: at } });
    return at;
  })()`);

/** The center of a character of the editor text (as in links.test.mjs). */
async function pointOf(app, needle, delta = 0) {
  const point = await app.eval(`(() => {
    const needle = ${JSON.stringify(needle)};
    for (const line of document.querySelectorAll('.cm-line')) {
      const at = line.textContent.indexOf(needle);
      if (at < 0) continue;
      let left = at + ${delta};
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (left < node.length) {
          const range = document.createRange();
          range.setStart(node, left);
          range.setEnd(node, left + 1);
          const box = range.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }
        left -= node.length;
      }
    }
    return null;
  })()`);
  assert.ok(point, `no text "${needle}" in the editor`);
  return point;
}

async function mouse(app, type, { x, y }, { ctrl = false } = {}) {
  await app.cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    clickCount: 1,
    modifiers: ctrl ? 2 : 0,
  });
}

async function click(app, point, options) {
  await mouse(app, "mouseMoved", point, options);
  await mouse(app, "mousePressed", point, options);
  await mouse(app, "mouseReleased", point, options);
  await sleep(150);
}

const centerOf = (app, selector) =>
  app.eval(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  })()`);

/** A profile folder with settings (the preview pane off: the editor gets the whole window) and the document. */
function setup(name = "doc.md", content = DOC) {
  const dir = tempProfile("kladde-livepreview-run");
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "settings.json"), JSON.stringify({ markdownPreview: "off" }));
  mkdirSync(join(dir, "files", "pics"), { recursive: true });
  writeFileSync(join(dir, "files", "pics", "dot.png"), DOT_PNG);
  const path = writeFixture(join(dir, "files"), name, content);
  return { dir, path };
}

async function ready(app, title) {
  await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(title)}`, 15000);
  await app.waitFor("!!document.querySelector('.cm-line')");
  // Focus in the page: the first key after a start is lost otherwise.
  await app.eval(`${view}.focus(), true`);
}

test("a Markdown file is shown formatted, marks appear where the cursor is, Ctrl+E switches to Source and back", async () => {
  const { dir, path } = setup();
  const urlLog = join(dir, "urls.log");
  const urls = () => (existsSync(urlLog) ? readFileSync(urlLog, "utf8").split("\n").filter(Boolean) : []);
  let app = await launch({ port: 9468, profile: dir, files: [path], env: { KLADDE_OPEN_URL_LOG: urlLog } });
  try {
    await ready(app, "doc.md");
    await app.waitFor("!!document.querySelector('.cm-editor.cm-live-preview')", 10000);
    assert.equal(await modeButton(app), "Live Preview");

    // The cursor starts on line 1, which shows its `#`; away from it the heading is drawn without.
    await cursorAt(app, "The end");
    assert.equal(await lineOf(app, "Title heading"), "Title heading");
    assert.equal(await app.eval("!!document.querySelector('.cm-line.cm-lp-h1')"), true, "the heading is sized");
    assert.equal(await lineOf(app, "Plain"), "Plain bold text and italic and the docs.", "marks of emphasis and the link hidden");
    assert.equal(await lineOf(app, "quoted words"), "quoted words", "the quote mark is hidden");
    assert.equal(await app.eval("document.querySelectorAll('.cm-lp-bullet').length"), 1, "a bullet is drawn for the plain item");
    assert.equal(await app.eval("document.querySelectorAll('.cm-lp-task').length"), 2, "task boxes");
    assert.equal(await app.eval("document.querySelectorAll('.cm-lp-task[aria-checked=true]').length"), 1);

    // The image next to the file loads.
    await app.waitFor("(() => { const i = document.querySelector('.cm-lp-img img'); return !!i && i.complete && i.naturalWidth > 0; })()", 10000);
    assert.equal(await lineOf(app, "![pic]"), null, "no image markup while the cursor is elsewhere");

    // The cursor in the bold text shows its marks, and only those of that element.
    await cursorAt(app, "bold text", 2);
    assert.equal(await lineOf(app, "Plain"), "Plain **bold text** and italic and the docs.");
    await cursorAt(app, "italic", 2);
    assert.equal(await lineOf(app, "Plain"), "Plain bold text and *italic* and the docs.");
    // Touching the link from its end shows the whole markup.
    await cursorAt(app, ".\n\n- [ ]");
    assert.equal(await lineOf(app, "Plain"), "Plain bold text and italic and [the docs](https://example.com/docs).");
    // A selection of the whole text reveals everything.
    await app.key("Ctrl+A");
    assert.equal(await lineOf(app, "Plain"), "Plain **bold text** and *italic* and [the docs](https://example.com/docs).");
    assert.equal(await app.eval("document.querySelectorAll('.cm-lp-task').length"), 0, "task boxes are text again");
    assert.equal(await lineOf(app, "![pic]"), "![pic](pics/dot.png)");

    // Source mode: all markup visible; the text, the tab and the undo history are untouched.
    await cursorAt(app, "The end");
    const text = await docText(app);
    assert.equal(text, DOC);
    await app.key("Ctrl+E");
    await app.waitFor("!document.querySelector('.cm-editor.cm-live-preview')");
    assert.equal(await modeButton(app), "Source");
    assert.equal(await lineOf(app, "Title heading"), "# Title heading");
    assert.equal(await lineOf(app, "Plain"), "Plain **bold text** and *italic* and [the docs](https://example.com/docs).");
    assert.equal(await docText(app), text);
    assert.equal(await tabClean(app), true, "switching never makes the tab dirty");
    await app.key("Ctrl+Z");
    assert.equal(await docText(app), text, "and adds nothing to undo");
    await app.key("Ctrl+E");
    await app.waitFor("!!document.querySelector('.cm-editor.cm-live-preview')");
    assert.equal(await modeButton(app), "Live Preview");
    assert.equal(await lineOf(app, "Title heading"), "Title heading");
    assert.equal(await docText(app), text);
    assert.equal(await tabClean(app), true);

    // The status bar item switches too.
    await app.eval("[...document.querySelectorAll('footer button')].find((b) => b.textContent.trim() === 'Live Preview').click()");
    await app.waitFor("!document.querySelector('.cm-editor.cm-live-preview')");
    await app.key("Ctrl+E");
    await app.waitFor("!!document.querySelector('.cm-editor.cm-live-preview')");

    // A task box: one click is one change, the cursor stays where it is, undo takes it back.
    await cursorAt(app, "The end", 3);
    const before = await position(app);
    await click(app, await centerOf(app, ".cm-lp-task[aria-checked=false]"));
    assert.equal(await docText(app), text.replace("- [ ] open task", "- [x] open task"));
    assert.equal(await position(app), before, "the click does not move the cursor into the line");
    assert.equal(await app.eval("document.querySelectorAll('.cm-lp-task[aria-checked=true]').length"), 2);
    assert.equal(await tabClean(app), false);
    await click(app, await centerOf(app, ".cm-lp-task[aria-checked=true]"));
    assert.equal(await docText(app), text, "a second click unchecks it again");
    await click(app, await centerOf(app, ".cm-lp-task[aria-checked=false]"));
    await app.eval(`${view}.focus(), true`);
    await app.key("Ctrl+Z");
    assert.equal(await docText(app), text, "Ctrl+Z restores the text in one step");
    assert.equal(await tabClean(app), true);

    // While a mouse button is held the text must not shift under the pointer: the marks appear on release.
    await cursorAt(app, "The end");
    const bold = await pointOf(app, "bold text", 2);
    await mouse(app, "mouseMoved", bold);
    await mouse(app, "mousePressed", bold);
    await sleep(150);
    assert.equal(await lineOf(app, "Plain"), "Plain bold text and italic and the docs.", "frozen while the button is down");
    await mouse(app, "mouseReleased", bold);
    await app.waitFor(`[...document.querySelectorAll('.cm-line')].some((l) => l.textContent.includes('**bold text**'))`);

    // Links: a plain click only places the cursor (which shows the markup); Ctrl+click opens, Ctrl held underlines.
    await cursorAt(app, "The end");
    await click(app, await pointOf(app, "the docs", 2));
    assert.deepEqual(urls(), [], "a plain click opens nothing");
    assert.equal(await lineOf(app, "Plain"), "Plain bold text and italic and [the docs](https://example.com/docs).");
    await cursorAt(app, "The end");
    const link = await pointOf(app, "the docs", 2);
    await app.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
    await mouse(app, "mouseMoved", link, { ctrl: true });
    await app.waitFor("!!document.querySelector('.cm-link-hover')");
    assert.match(await app.eval("document.querySelector('.cm-link-hover').textContent"), /the docs/);
    await app.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 });
    await click(app, link, { ctrl: true });
    assert.deepEqual(urls(), ["https://example.com/docs"], "Ctrl+click opens the link behind the rendered text");
    assert.equal(await lineOf(app, "Plain"), "Plain bold text and italic and the docs.", "and does not move the cursor");

    // Left in Source mode for the restart below.
    await app.key("Ctrl+E");
    await app.waitFor("!document.querySelector('.cm-editor.cm-live-preview')");
    await app.close();
    assert.equal(JSON.parse(readFileSync(join(dir, "data", "session.json"), "utf8")).tabs[0].markdownSource, true);

    // The mode comes back with the session; going back to Live Preview stores nothing.
    app = await launch({ port: 9469, profile: dir, env: { KLADDE_OPEN_URL_LOG: urlLog } });
    await ready(app, "doc.md");
    assert.equal(await modeButton(app), "Source");
    assert.equal(await live(app), false);
    assert.equal(await lineOf(app, "Title heading"), "# Title heading");
    await app.key("Ctrl+E");
    await app.waitFor("!!document.querySelector('.cm-editor.cm-live-preview')");
    await app.close();
    assert.equal("markdownSource" in JSON.parse(readFileSync(join(dir, "data", "session.json"), "utf8")).tabs[0], false);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("pasted Markdown in an untitled tab renders, other languages do not, and read-only tabs do not toggle boxes", async () => {
  const { dir, path } = setup("locked.md", "- [ ] locked task\n\nplain text\n\0");
  const app = await launch({ port: 9470, profile: dir, files: [path] });
  try {
    await ready(app, "locked.md");
    // A file with a NUL byte opens read-only: rendered, but the box does nothing. (The cursor starts on the item,
    // which shows its marker as text.)
    await app.waitFor("!!document.querySelector('.cm-editor.cm-live-preview')", 10000);
    await cursorAt(app, "plain text");
    await app.waitFor("!!document.querySelector('.cm-lp-task')", 10000);
    assert.equal(await app.eval("!!document.querySelector('.cm-lp-task-readonly')"), true);
    await click(app, await centerOf(app, ".cm-lp-task"));
    assert.equal((await docText(app)).startsWith("- [ ] locked task"), true, "a read-only tab keeps its text");
    assert.equal(await app.eval("document.querySelectorAll('.cm-lp-task[aria-checked=true]').length"), 0);

    // A new tab: plain text has none; the first paste of Markdown switches the language and renders.
    const tabs = (await app.state()).tabs.length;
    await app.key("Ctrl+N");
    await app.waitFor(`document.querySelectorAll('.tab .title').length === ${tabs + 1}`);
    await app.eval(`${view}.focus(), true`);
    assert.equal(await live(app), false, "plain text: no Live Preview");
    assert.equal(await modeButton(app), null, "and no item in the status bar");
    await app.eval(`(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "# Pasted notes\\n\\nSome **strong** words and a list:\\n\\n- one\\n- two\\n");
      document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await app.waitFor("!!document.querySelector('.cm-editor.cm-live-preview')", 10000);
    assert.equal(await modeButton(app), "Live Preview");
    assert.equal(await lineOf(app, "Some"), "Some strong words and a list:");
    assert.equal(await app.eval("!!document.querySelector('.cm-line.cm-lp-h1')"), true);

    // Another language takes it away again, Markdown brings it back (in Live Preview, not Source).
    await app.key("Ctrl+E");
    await app.waitFor("!document.querySelector('.cm-editor.cm-live-preview')");
    for (const [label, expectLive] of [["Plain Text", false], ["Markdown", true]]) {
      await app.key("Ctrl+Shift+P");
      await app.waitFor("!!document.querySelector('.picker input')");
      await app.type("Change language mode");
      await app.waitFor("!!document.querySelector('.picker [role=option]')");
      await app.key("Enter");
      await app.waitFor(`document.querySelector('.picker input')?.placeholder === "Select language mode"`);
      await app.type(label);
      await app.waitFor(`document.querySelector('.picker [role=option]')?.textContent.includes(${JSON.stringify(label)})`);
      await app.key("Enter");
      await app.waitFor("!document.querySelector('.picker')");
      await app.waitFor(`document.querySelector('footer button[title="Select language"]')?.textContent.trim() === ${JSON.stringify(label)}`);
      await sleep(300);
      assert.equal(await live(app), expectLive, label);
    }
    assert.equal(await modeButton(app), "Live Preview", "Source was reset by the other language");
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});
