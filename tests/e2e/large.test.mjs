// Large file viewer: UTF-16, regex and Unicode search, highlighting, following a growing file and
// opening in the editor. A lowered threshold (settings.json) keeps the fixtures small. Needs a debug build:
//   npx tauri build --debug --no-bundle && node --test tests/e2e/large.test.mjs
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-large");
after(() => removeProfile(profile));

// Everything above 50 KB opens in the viewer.
function settingsFor(dir) {
  writeFixture(join(dir, "data"), "settings.json", JSON.stringify({ largeFileThresholdMB: 0.05 }));
}

function utf16(text, littleEndian) {
  const le = Buffer.from(text, "utf16le");
  if (littleEndian) return Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
  const be = Buffer.from(le);
  be.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

const rows = (n, make) => Array.from({ length: n }, (_, i) => make(i)).join("\r\n");

/** The text of the lines on screen. */
const shown = (app) => app.eval(`[...document.querySelectorAll('.large .line .text')].map((e) => e.textContent)`);
const message = (app) => app.eval(`document.querySelector('.large .toolbar .message')?.textContent ?? ''`);
const marked = (app) => app.eval(`[...document.querySelectorAll('.large mark')].map((e) => e.textContent).join('')`);
const status = (app) => app.eval(`document.querySelector('footer')?.textContent ?? ''`);

/** Activates a tab by its title with a real click (tabs react to pointer events). */
async function openTab(app, title) {
  const { x, y } = await app.eval(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.title')?.textContent === ${JSON.stringify(title)});
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(title)}`);
}

/** Matches a line count whatever the locale's thousands separator is. */
const lineCount = (n) => new RegExp(String(n).replace(/(\d)(?=(\d{3})+$)/, "$1[.,]?") + " lines");

async function search(app, text) {
  await app.eval(`(() => { const i = document.querySelector('.large .toolbar input'); i.focus(); i.select(); })()`);
  await app.type(text);
  await app.key("Enter");
}

async function waitIndexed(app) {
  await app.waitFor(`document.querySelector('.large') && !document.body.innerText.includes('Indexing')`, 10000);
}

test("UTF-16 files open in the viewer and can be searched", async () => {
  const dir = tempProfile("kladde-large-utf16");
  settingsFor(dir);
  const text = rows(3000, (i) => `Zeile ${i} Grüße aus München ${i % 7 === 0 ? "ERROR" : "ok"}`);
  const le = writeFixture(dir, "le.txt", utf16(text, true));
  const be = writeFixture(dir, "be.txt", utf16(text, false));
  const app = await launch({ port: 9345, profile: dir, files: [le, be] });
  try {
    await app.waitFor(`document.querySelectorAll('.tab').length === 2`, 10000);
    // Both are large tabs, and the first line decodes correctly in either byte order.
    for (const name of ["le.txt", "be.txt"]) {
      await openTab(app, name);
      await app.waitFor(`document.querySelector('.large .line .text')?.textContent.startsWith('Zeile 0')`);
      await waitIndexed(app);
      assert.equal((await shown(app))[0], "Zeile 0 Grüße aus München ERROR");
      assert.match(await status(app), lineCount(3000));
      assert.match(await status(app), /UTF-16/);

      // Search with the default case-insensitive toggle (Unicode: ü matches Ü).
      await search(app, "zeile 2999 GRÜßE aus MÜNCHEN");
      await app.waitFor(`document.querySelector('.large mark')`);
      assert.equal(await marked(app), "Zeile 2999 Grüße aus München");
      assert.ok((await shown(app)).some((l) => l.startsWith("Zeile 2999 ")));
    }
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("regex and case-sensitive search, errors and previous matches", async () => {
  const dir = tempProfile("kladde-large-search");
  settingsFor(dir);
  const text = rows(2500, (i) => `row ${i} Straße ${i % 5 === 0 ? "Alpha" : "beta"} id=${i * 3}`);
  const file = writeFixture(dir, "search.txt", text);
  const app = await launch({ port: 9391, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await waitIndexed(app);

    await search(app, "STRASSE");
    await app.waitFor(`document.querySelector('.large .toolbar .message')?.textContent === 'No results'`);

    // Regex: numbers with three digits followed by the end of the line.
    await app.click(`.large .toggle[title='Regular expression']`);
    await search(app, "Alpha id=\\d{4}$");
    await app.waitFor(`document.querySelector('.large mark')`);
    assert.match(await marked(app), /^Alpha id=\d{4}$/);

    // Next goes on after the match, previous goes back (wrapping around at the start).
    const first = await marked(app);
    await app.key("F3");
    await app.waitFor(`[...document.querySelectorAll('.large mark')].map((e) => e.textContent).join('') !== ${JSON.stringify(first)}`);
    await app.key("Shift+F3");
    await app.waitFor(`[...document.querySelectorAll('.large mark')].map((e) => e.textContent).join('') === ${JSON.stringify(first)}`);

    // An invalid pattern shows the reason instead of failing silently.
    await app.eval(`(() => { const i = document.querySelector('.large .toolbar input'); i.focus(); i.select(); })()`);
    await app.type("(unclosed");
    await app.key("Enter");
    await app.waitFor(`document.querySelector('.large .toolbar .message')?.textContent.startsWith('Invalid regular expression')`);

    // Match case: "alpha" no longer matches "Alpha"; "Alpha" does.
    await app.click(`.large .toggle[title='Regular expression']`);
    await app.click(`.large .toggle[title='Match case']`);
    await search(app, "alpha");
    await app.waitFor(`document.querySelector('.large .toolbar .message')?.textContent === 'No results'`);
    await search(app, "Alpha");
    await app.waitFor(`document.querySelector('.large mark')`);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("log files are highlighted in the viewer", async () => {
  const dir = tempProfile("kladde-large-hl");
  settingsFor(dir);
  const text = rows(2000, (i) => `2024-05-01 12:00:${String(i % 60).padStart(2, "0")} ${i % 2 ? "ERROR" : "INFO"} message ${i}`);
  const log = writeFixture(dir, "app.log", text);
  const plain = writeFixture(dir, "app.txt", text);
  const app = await launch({ port: 9392, profile: dir, files: [log, plain] });
  try {
    await app.waitFor(`document.querySelectorAll('.tab').length === 2`, 10000);
    // The plain text file stays plain.
    await app.waitFor(`document.querySelector('.large .line .text')`);
    assert.equal(await app.eval(`document.querySelectorAll('.large .line .text span').length`), 0);

    await openTab(app, "app.log");
    await app.waitFor(`document.querySelector('.large .line .text .tok-log-date')`);
    assert.ok(await app.eval(`!!document.querySelector('.large .line .text .tok-log-error')`));
    assert.ok(await app.eval(`!!document.querySelector('.large .line .text .tok-log-info')`));
    // The text is unchanged by the spans.
    assert.equal((await shown(app))[0], "2024-05-01 12:00:00 INFO message 0");

    // A search match inside a highlighted token keeps the token's color.
    await app.click(`.large .toggle[title='Match case']`);
    await search(app, "ERROR message 1");
    await app.waitFor(`document.querySelector('.large mark')`);
    assert.equal(await marked(app), "ERROR message 1");
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("a growing file is followed, a shortened one is reopened", async () => {
  const dir = tempProfile("kladde-large-follow");
  settingsFor(dir);
  const line = (i) => `line ${i} ${"x".repeat(40)}`;
  const file = writeFixture(dir, "grow.log", rows(2500, line) + "\r\n");
  const app = await launch({ port: 9393, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await waitIndexed(app);
    assert.match(await status(app), lineCount(2500));

    // At the end of the file (Ctrl+End): appended lines scroll into view, with no banner.
    await app.eval(`document.querySelector('.large .viewport').focus()`);
    await app.key("Ctrl+End");
    await app.waitFor(`document.querySelector('.large .line:last-child .text')?.textContent.startsWith('line 24')`);
    appendFileSync(file, rows(40, (i) => line(2500 + i)) + "\r\n");
    await app.waitFor(`document.body.innerText.includes('line 2539 ')`, 10000);
    assert.match(await status(app), lineCount(2540));
    assert.equal(await app.eval(`!!document.querySelector('.banner')`), false);

    // A partly written last line is completed in place.
    appendFileSync(file, "partial");
    await app.waitFor(`document.body.innerText.includes('partial')`, 10000);
    appendFileSync(file, " and done\r\n");
    await app.waitFor(`document.body.innerText.includes('partial and done')`, 10000);

    // Scrolled to the top: the view stays where it is while the file grows.
    await app.key("Ctrl+Home");
    appendFileSync(file, rows(10, (i) => line(9000 + i)) + "\r\n");
    await app.waitFor(`/2[.,]?551 lines/.test(document.querySelector('footer').textContent)`, 10000);
    assert.equal((await shown(app))[0].startsWith("line 0 "), true);

    // Shortened (e.g. rotated and restarted): reopened, shows the new content.
    writeFileSync(file, rows(300, (i) => `fresh ${i}`) + "\r\n");
    await app.waitFor(`/\\b300 lines/.test(document.querySelector('footer').textContent)`, 10000);
    await app.waitFor(`document.querySelector('.large .line .text')?.textContent === 'fresh 0'`, 10000);
    assert.equal(await app.eval(`!!document.querySelector('.banner')`), false);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("a large file can be opened in the editor", async () => {
  const dir = tempProfile("kladde-large-edit");
  settingsFor(dir);
  const file = writeFixture(dir, "edit.txt", rows(3000, (i) => `editable line ${i}`) + "\r\n");
  const app = await launch({ port: 9345, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await app.click(`.large .toolbar button[title^='Load the whole file']`);
    await app.waitFor(`document.querySelector('.dialog')`);
    assert.match(await app.eval(`document.querySelector('.dialog').textContent`), /memory/);

    // Cancel keeps the viewer.
    await app.eval(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Cancel').click()`);
    await app.waitFor(`!document.querySelector('.dialog')`);
    assert.ok(await app.eval(`!!document.querySelector('.large')`));

    await app.click(`.large .toolbar button[title^='Load the whole file']`);
    await app.waitFor(`document.querySelector('.dialog')`);
    await app.eval(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Open in editor').click()`);
    await app.waitFor(`document.querySelector('.cm-content')?.textContent.includes('editable line 0')`, 10000);
    assert.equal(await app.eval(`!!document.querySelector('.large')`), false);
    assert.deepEqual((await app.state()).tabs, ["edit.txt"]);

    // It is a normal tab now: typing makes it unsaved.
    await app.key("Ctrl+Home");
    await app.type("X");
    assert.deepEqual((await app.state()).dirty, ["edit.txt"]);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});
