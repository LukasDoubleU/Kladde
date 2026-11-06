// Links in the editor: Ctrl+click opens them, plain clicks and Ctrl+click elsewhere keep working, the hover
// hint. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
//
// Mouse and key events go into the page through DevTools, never to the desktop. External links are not opened:
// KLADDE_OPEN_URL_LOG (isolated profile only) makes Kladde write the URL it would have opened into a file.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-links");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Short lines: the editor is only half of the window (the preview is open), and a click needs the text in view.
const MAIN = [
  "# Main title", //                                1
  "", //                                            2
  "See [other file](other.md) for details.", //     3
  "Spaced: [the notes](my%20notes.md#top) here.", // 4
  "Jump to [the setup](#setup-steps) below.", //    5
  "Web: [the site](https://example.com/docs) ok", // 6
  "Bare https://example.org/plain, then more.", //  7
  "Mail <mailto:me@example.com>.", //               8
  "Not: [x](file:///C:/Windows/notepad.exe)", //    9
  "Not: [y](javascript:void(0))", //                10
  "Not: [z](foo-app:open)", //                      11
  "Not: [u](//server/share/a.md)", //               12
  "Words to click on in plain text.", //            13
  "", //                                            14
  "## Setup steps", //                              15
  "", //                                            16
  "Text under the setup.", //                       17
].join("\n");
const SETUP_LINE = 15;

/** Starts Kladde with files open and a URL log; `body(app, urls)` gets a function returning the logged URLs. */
async function session({ port, files, active }, body) {
  const dir = tempProfile("kladde-links-run");
  const log = join(dir, "urls.log");
  const app = await launch({ port, profile: dir, files, env: { KLADDE_OPEN_URL_LOG: log } });
  try {
    await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(active)}`, 15000);
    await app.waitFor("!!document.querySelector('.cm-line')");
    await body(app, () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []));
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
}

/** The center of a character of the editor text: `needle` is a text of one line, `delta` the offset into it. */
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

const MODIFIERS = { ctrl: 2 };

async function mouse(app, type, { x, y }, { ctrl = false, count = 1 } = {}) {
  const modifiers = ctrl ? MODIFIERS.ctrl : 0;
  const button = type === "mouseMoved" ? "none" : "left";
  await app.cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: count, modifiers });
}

async function click(app, point, options) {
  await mouse(app, "mouseMoved", point, options);
  await mouse(app, "mousePressed", point, options);
  await mouse(app, "mouseReleased", point, options);
  await sleep(150);
}

/** Holds or releases the Ctrl key without any other key. */
const control = (app, down) =>
  app.cdp.send("Input.dispatchKeyEvent", {
    type: down ? "rawKeyDown" : "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: down ? MODIFIERS.ctrl : 0,
  });

const position = (app) => app.eval("document.querySelector('footer').innerText.match(/Ln (\\d+), Col (\\d+)/)?.slice(1).join(':')");
const cursors = (app) => app.eval("document.querySelectorAll('.cm-cursor').length");
const hovered = (app) =>
  app.eval(`[...document.querySelectorAll('.cm-link-hover')].map((e) => e.textContent).join('|')`);

test("Ctrl+click opens a relative Markdown link in a new tab, with the query and fragment ignored and escapes decoded", async () => {
  const main = writeFixture(profile, "main.md", MAIN);
  writeFixture(profile, "other.md", "# The other file\n");
  writeFixture(profile, "my notes.md", "# My notes\n");
  await session({ port: 9405, files: [main], active: "main.md" }, async (app) => {
    await click(app, await pointOf(app, "other file"), { ctrl: true });
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'other.md'");
    assert.deepEqual((await app.state()).tabs, ["main.md", "other.md"]);

    // A link back in the first tab, on its target this time.
    await app.key("Alt+Left");
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'main.md'");
    await click(app, await pointOf(app, "my%20notes.md", 4), { ctrl: true });
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'my notes.md'");
    assert.deepEqual((await app.state()).tabs, ["main.md", "other.md", "my notes.md"]);
  });
});

test("Ctrl+click on #heading moves the cursor to the heading", async () => {
  const main = writeFixture(profile, "anchor.md", MAIN);
  await session({ port: 9406, files: [main], active: "anchor.md" }, async (app) => {
    await click(app, await pointOf(app, "the setup"), { ctrl: true });
    await app.waitFor(`document.querySelector('footer').innerText.includes('Ln ${SETUP_LINE}, Col 1')`);
    assert.equal(await cursors(app), 1);
    assert.deepEqual((await app.state()).tabs, ["anchor.md"], "no new tab");
  });
});

test("Ctrl+click on text that is not a link still adds a cursor, and on a link it adds none and moves none", async () => {
  const main = writeFixture(profile, "cursors.md", MAIN);
  await session({ port: 9407, files: [main], active: "cursors.md" }, async (app, urls) => {
    await click(app, await pointOf(app, "Words to click"));
    assert.equal(await cursors(app), 1);
    const before = await position(app);

    await click(app, await pointOf(app, "plain text"), { ctrl: true });
    assert.equal(await cursors(app), 2, "the second cursor");
    await click(app, await pointOf(app, "Text under"), { ctrl: true });
    assert.equal(await cursors(app), 3, "and a third");

    // On a link: opens it, keeps the three cursors and the main cursor where it is.
    const main3 = await position(app);
    await click(app, await pointOf(app, "the site"), { ctrl: true });
    assert.deepEqual(urls(), ["https://example.com/docs"]);
    assert.equal(await cursors(app), 3);
    assert.equal(await position(app), main3);
    assert.notEqual(before, main3);
  });
});

test("a plain click or double-click on a link opens nothing", async () => {
  const main = writeFixture(profile, "plain.md", MAIN);
  await session({ port: 9408, files: [main], active: "plain.md" }, async (app, urls) => {
    await click(app, await pointOf(app, "other file"));
    await click(app, await pointOf(app, "the setup"));
    await click(app, await pointOf(app, "the site"));
    await click(app, await pointOf(app, "https://example.org", 10));
    assert.deepEqual(urls(), []);
    assert.deepEqual((await app.state()).tabs, ["plain.md"]);
    // The click moved the cursor into the URL.
    assert.equal(await cursors(app), 1);
    assert.match(await position(app), /^7:/);

    // A double-click selects a word, also inside a URL.
    const point = await pointOf(app, "example.org", 2);
    await mouse(app, "mouseMoved", point);
    for (const count of [1, 2]) {
      await mouse(app, "mousePressed", point, { count });
      await mouse(app, "mouseReleased", point, { count });
    }
    await app.waitFor("document.querySelector('footer').innerText.includes('7 selected')");
    assert.deepEqual(urls(), []);
    assert.deepEqual((await app.state()).tabs, ["plain.md"]);
  });
});

test("Ctrl+click opens http(s) and mailto links only, in Markdown links, autolinks and bare URLs", async () => {
  const main = writeFixture(profile, "external.md", MAIN);
  await session({ port: 9409, files: [main], active: "external.md" }, async (app, urls) => {
    await click(app, await pointOf(app, "the site"), { ctrl: true });
    await click(app, await pointOf(app, "https://example.com/docs", 12), { ctrl: true });
    await click(app, await pointOf(app, "https://example.org/plain"), { ctrl: true });
    // The comma after the URL is not part of it, and clicking it opens nothing.
    await click(app, await pointOf(app, "plain,", 5), { ctrl: true });
    await click(app, await pointOf(app, "mailto:me@example.com", 10), { ctrl: true });
    assert.deepEqual(urls(), [
      "https://example.com/docs",
      "https://example.com/docs",
      "https://example.org/plain",
      "mailto:me@example.com",
    ]);

    // Other schemes and network paths do nothing: no log entry, no tab, no notice.
    for (const needle of ["[x]", "[y]", "[z]", "[u]"]) await click(app, await pointOf(app, needle, 1), { ctrl: true });
    for (const needle of ["file:///C:", "javascript:void", "foo-app:open", "//server/share"]) {
      await click(app, await pointOf(app, needle, 3), { ctrl: true });
    }
    assert.equal(urls().length, 4);
    const state = await app.state();
    assert.deepEqual(state.tabs, ["external.md"]);
    assert.equal(state.notice, null);
  });
});

test("in other file types only URLs are links, and trailing punctuation is left out", async () => {
  const file = writeFixture(
    profile,
    "app.log",
    [
      "2026-01-01 started, see https://example.com/status.", //   1
      "(docs: https://en.wikipedia.org/wiki/Log_(computing))", // 2
      '{"url":"https://example.com/api?a=1&b=2","ok":true}', //   3
      "[not a link](page.md)", //                                 4
    ].join("\n"),
  );
  await session({ port: 9410, files: [file], active: "app.log" }, async (app, urls) => {
    await click(app, await pointOf(app, "example.com/status", 3), { ctrl: true });
    await click(app, await pointOf(app, "wikipedia", 2), { ctrl: true });
    await click(app, await pointOf(app, "example.com/api", 3), { ctrl: true });
    await click(app, await pointOf(app, "not a link", 2), { ctrl: true });
    await click(app, await pointOf(app, "page.md", 2), { ctrl: true });
    assert.deepEqual(urls(), [
      "https://example.com/status",
      "https://en.wikipedia.org/wiki/Log_(computing)",
      "https://example.com/api?a=1&b=2",
    ]);
    assert.deepEqual((await app.state()).tabs, ["app.log"], "Markdown links are not links in a log");
  });
});

test("the link under the mouse is underlined with a hand while Ctrl is held", async () => {
  const main = writeFixture(profile, "hover.md", MAIN);
  await session({ port: 9411, files: [main], active: "hover.md" }, async (app) => {
    const link = await pointOf(app, "the site");
    const text = await pointOf(app, "Words to click");

    // Ctrl pressed over a still mouse, then the mouse moves.
    await mouse(app, "mouseMoved", link);
    assert.equal(await hovered(app), "", "nothing without Ctrl");
    await control(app, true);
    await app.waitFor("!!document.querySelector('.cm-link-hover')");
    assert.equal(await hovered(app), "[the site](https://example.com/docs)");
    const style = await app.eval(`(() => { const s = getComputedStyle(document.querySelector('.cm-link-hover')); return { cursor: s.cursor, decoration: s.textDecorationLine }; })()`);
    assert.deepEqual(style, { cursor: "pointer", decoration: "underline" });

    // Another link, then plain text: the hint follows the mouse.
    await mouse(app, "mouseMoved", await pointOf(app, "other file"), { ctrl: true });
    await app.waitFor("document.querySelector('.cm-link-hover')?.textContent === '[other file](other.md)'");
    await mouse(app, "mouseMoved", text, { ctrl: true });
    await app.waitFor("!document.querySelector('.cm-link-hover')");

    // Releasing Ctrl removes it.
    await mouse(app, "mouseMoved", link, { ctrl: true });
    await app.waitFor("!!document.querySelector('.cm-link-hover')");
    await control(app, false);
    await app.waitFor("!document.querySelector('.cm-link-hover')");

    // So does leaving the editor, and so does the window losing the focus.
    await control(app, true);
    await mouse(app, "mouseMoved", link, { ctrl: true });
    await app.waitFor("!!document.querySelector('.cm-link-hover')");
    await mouse(app, "mouseMoved", { x: 5, y: 5 }, { ctrl: true });
    await app.waitFor("!document.querySelector('.cm-link-hover')");
    await mouse(app, "mouseMoved", link, { ctrl: true });
    await app.waitFor("!!document.querySelector('.cm-link-hover')");
    await app.eval("window.dispatchEvent(new Event('blur')), true");
    await app.waitFor("!document.querySelector('.cm-link-hover')");
    await control(app, false);
    assert.equal(await cursors(app), 1);
  });
});

test("the command \"Open link at cursor\" opens the link at the main cursor", async () => {
  const main = writeFixture(profile, "command.md", MAIN);
  writeFixture(profile, "other.md", "# The other file\n");
  await session({ port: 9412, files: [main], active: "command.md" }, async (app, urls) => {
    const run = async () => {
      await app.key("Ctrl+Shift+P");
      await app.waitFor("!!document.querySelector('.picker input')");
      await app.type("Open link at cursor");
      await app.waitFor("!!document.querySelector('.picker [role=option]')?.textContent.includes('Open link at cursor')");
      await app.key("Enter");
      await sleep(200);
    };

    // In text: a notice, nothing opens.
    await click(app, await pointOf(app, "Words to click"));
    await run();
    assert.match((await app.state()).notice ?? "", /no link at the cursor/i);
    assert.deepEqual(urls(), []);

    await click(app, await pointOf(app, "https://example.org/plain", 3));
    await run();
    assert.deepEqual(urls(), ["https://example.org/plain"]);

    // A Markdown link, from its text.
    await click(app, await pointOf(app, "other file"));
    await run();
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'other.md'");
  });
});
