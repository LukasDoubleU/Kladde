// Large file viewer: UTF-16, regex and Unicode search, highlighting, following a growing file, opening in
// the editor, and editing (typing, undo, saving, hot exit with unsaved edits, changes on disk). A lowered
// threshold (settings.json) keeps the fixtures small. The editing tests reuse ports of earlier tests of
// this file, one app at a time. Needs a debug build:
//   npx tauri build --debug --no-bundle && node --test tests/e2e/large.test.mjs
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    assert.equal(await app.eval(`document.querySelectorAll('.large .line .text span:not(.caret)').length`), 0);

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
    // A final line break is followed by an empty line, where the caret can go.
    assert.match(await status(app), lineCount(2501));

    // At the end of the file (Ctrl+End, the empty last line): appended lines scroll into view, with no banner.
    await app.eval(`document.querySelector('.large .viewport').focus()`);
    await app.key("Ctrl+End");
    await app.waitFor(`document.querySelector('.large .line:nth-last-child(2) .text')?.textContent.startsWith('line 24')`);
    appendFileSync(file, rows(40, (i) => line(2500 + i)) + "\r\n");
    await app.waitFor(`document.body.innerText.includes('line 2539 ')`, 10000);
    assert.match(await status(app), lineCount(2541));
    assert.equal(await app.eval(`!!document.querySelector('.banner')`), false);

    // A partly written last line is completed in place.
    appendFileSync(file, "partial");
    await app.waitFor(`document.body.innerText.includes('partial')`, 10000);
    appendFileSync(file, " and done\r\n");
    await app.waitFor(`document.body.innerText.includes('partial and done')`, 10000);

    // Scrolled to the top: the view stays where it is while the file grows.
    await app.key("Ctrl+Home");
    appendFileSync(file, rows(10, (i) => line(9000 + i)) + "\r\n");
    await app.waitFor(`/2[.,]?552 lines/.test(document.querySelector('footer').textContent)`, 10000);
    assert.equal((await shown(app))[0].startsWith("line 0 "), true);

    // Shortened (e.g. rotated and restarted): reopened, shows the new content.
    writeFileSync(file, rows(300, (i) => `fresh ${i}`) + "\r\n");
    await app.waitFor(`/\\b301 lines/.test(document.querySelector('footer').textContent)`, 10000);
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

// ---------------------------------------------------------------- editing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const focusView = (app) => app.eval(`document.querySelector('.large .input').focus(), true`);
const dirtyTabs = async (app) => (await app.state()).dirty;
const pad = "ünï " + "x".repeat(20);
const row = (i) => `row ${i} ${pad}`;
/** The fixture: 3000 CRLF lines and a final line break (so an empty last line). */
const fixture = () => rows(3000, row) + "\r\n";

/** Waits until the lines on screen, from the first one on, are these. */
const shownIs = (app, expected) =>
  app.waitFor(
    `(() => { const got = [...document.querySelectorAll('.large .line .text')].map((e) => e.textContent); return JSON.stringify(got.slice(0, ${expected.length})) === ${JSON.stringify(JSON.stringify(expected))}; })()`,
    5000,
  );

/** The hot-exit journal of the only large tab in a profile, or null. */
function journalOf(dir) {
  const folder = join(dir, "data", "backup");
  if (!existsSync(folder)) return null;
  const name = readdirSync(folder).find((n) => n.endsWith(".large.json"));
  return name ? JSON.parse(readFileSync(join(folder, name), "utf8")) : null;
}

const journalFiles = (dir) => {
  const folder = join(dir, "data", "backup");
  return existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith(".large.json") || n.endsWith(".add")) : [];
};

async function until(condition, what, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const saved = (app) => app.waitFor(`!document.querySelector('.tab.dirty')`, 10000);

test("typing, deleting, undo, search and saving in a large file", async () => {
  const dir = tempProfile("kladde-large-type");
  settingsFor(dir);
  const file = writeFixture(dir, "type.txt", fixture());
  const app = await launch({ port: 9397, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await waitIndexed(app);
    await focusView(app);
    assert.deepEqual(await dirtyTabs(app), []);

    // Typing makes the tab unsaved; Enter splits the line.
    await app.key("Ctrl+Home");
    await app.type("Hello ");
    await shownIs(app, [`Hello ${row(0)}`]);
    assert.deepEqual(await dirtyTabs(app), ["type.txt"]);
    await sleep(700); // a pause starts a new undo step
    await app.key("Enter");
    await shownIs(app, ["Hello ", row(0)]);

    // Undo goes back step by step; undoing everything makes the tab clean again, redo brings it back.
    await app.key("Ctrl+Z");
    await shownIs(app, [`Hello ${row(0)}`]);
    assert.deepEqual(await dirtyTabs(app), ["type.txt"]);
    await app.key("Ctrl+Z");
    await shownIs(app, [row(0), row(1)]);
    await app.waitFor(`!document.querySelector('.tab.dirty')`);
    await app.key("Ctrl+Y");
    await shownIs(app, [`Hello ${row(0)}`]);
    await app.key("Ctrl+Shift+Z");
    await shownIs(app, ["Hello ", row(0), row(1)]);
    assert.deepEqual(await dirtyTabs(app), ["type.txt"]);

    // Selecting with the keyboard and typing replaces the selection ("row " of the third line becomes "X").
    await app.key("ArrowDown");
    await app.key("Home");
    for (let i = 0; i < 4; i++) await app.key("Shift+ArrowRight");
    await app.type("X");
    await shownIs(app, ["Hello ", row(0), `X1 ${pad}`]);

    // Backspace joins with the line above, Delete with the line below.
    await app.key("Home");
    await app.key("Backspace");
    await shownIs(app, ["Hello ", `${row(0)}X1 ${pad}`, row(2)]);
    await app.key("End");
    await app.key("Delete");
    await shownIs(app, ["Hello ", `${row(0)}X1 ${pad}${row(2)}`, row(3)]);

    // Paste (CRLF is normalized) at the end of the document, then a search sees the new text.
    await app.key("Ctrl+End");
    await app.eval(`(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'P1\\r\\nP2 zzq');
      document.querySelector('.large .input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await app.waitFor(`document.body.innerText.includes('P2 zzq')`);
    await search(app, "zzq");
    await app.waitFor(`document.querySelector('.large mark')`);
    assert.equal(await marked(app), "zzq");
    await focusView(app);

    // Save: the file is replaced, encoding and CRLF kept, and the tab goes on with the saved file.
    const lines = fixture().split("\r\n");
    lines.splice(0, 3, "Hello ", `${row(0)}X1 ${pad}${row(2)}`);
    lines[lines.length - 1] = "P1";
    lines.push("P2 zzq");
    const expected = lines.join("\r\n");
    await app.key("Ctrl+S");
    await saved(app);
    assert.equal(readFileSync(file, "utf8"), expected);
    assert.equal(existsSync(join(dir, ".type.txt.kladde-save")), false);
    assert.match(await status(app), lineCount(lines.length));
    assert.ok((await shown(app)).includes("P2 zzq"));

    // Editing goes on in the saved file; saving again works.
    await app.key("Ctrl+Home");
    await app.type("!");
    assert.deepEqual(await dirtyTabs(app), ["type.txt"]);
    await app.key("Ctrl+S");
    await saved(app);
    assert.equal(readFileSync(file, "utf8"), "!" + expected);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("line commands work in a large file", async () => {
  const dir = tempProfile("kladde-large-lines");
  settingsFor(dir);
  const file = writeFixture(dir, "lines.txt", fixture());
  const app = await launch({ port: 9391, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await waitIndexed(app);
    await focusView(app);
    await app.key("Ctrl+Home");
    await app.key("ArrowDown");
    // Delete line (Ctrl+D) and duplicate line (Shift+Alt+Down) are the editor's commands under the same keys.
    await app.key("Ctrl+D");
    await shownIs(app, [row(0), row(2), row(3)]);
    await sleep(100);
    await app.key("Shift+Alt+ArrowDown");
    await shownIs(app, [row(0), row(2), row(2), row(3)]);
    await app.key("Ctrl+Z");
    await shownIs(app, [row(0), row(2), row(3)]);
    await app.key("Ctrl+Z");
    await shownIs(app, [row(0), row(1), row(2)]);
    await app.waitFor(`!document.querySelector('.tab.dirty')`);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

/** Opens a fixture, makes edits, waits until they are in the journal and crashes the app. */
async function editAndCrash(port, dir, file) {
  const app = await launch({ port, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await waitIndexed(app);
    await focusView(app);
    await app.key("Ctrl+Home");
    for (let i = 0; i < 5; i++) await app.key("ArrowDown");
    await app.key("Ctrl+D");
    await app.key("Ctrl+Home");
    await app.type("ONE ");
    await app.key("Ctrl+End");
    await app.type("END");
    assert.equal((await dirtyTabs(app)).length, 1);
    // Throttled like normal backups: the journal catches up while typing goes on, then it is complete.
    await until(() => journalOf(dir)?.addedLen === "ONE END".length, "the journal of the edits");
  } finally {
    await app.kill();
  }
}

/** The fixture after editAndCrash. */
const editedLines = () => {
  const lines = fixture().split("\r\n");
  lines.splice(5, 1);
  lines[0] = "ONE " + lines[0];
  lines[lines.length - 1] = "END";
  return lines;
};

test("unsaved edits of a large file survive a crash", async () => {
  const dir = tempProfile("kladde-large-crash");
  settingsFor(dir);
  const file = writeFixture(dir, "crash.txt", fixture());
  await editAndCrash(9398, dir, file);
  // The file itself is untouched until the user saves.
  assert.equal(readFileSync(file, "utf8"), fixture());

  const app = await launch({ port: 9399, profile: dir });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await app.waitFor(`document.querySelector('.tab.dirty') && !document.querySelector('footer').textContent.includes('Restoring')`, 10000);
    await waitIndexed(app);
    assert.equal(await app.eval(`!!document.querySelector('.banner')`), false);
    const lines = editedLines();
    await shownIs(app, lines.slice(0, 7));
    await focusView(app);
    await app.key("Ctrl+End");
    await app.waitFor(`document.querySelector('.large .line:last-child .text')?.textContent === 'END'`);
    assert.match(await status(app), lineCount(lines.length));

    // Saving writes the edits and removes the journal; nothing is left to restore.
    await app.key("Ctrl+S");
    await saved(app);
    assert.equal(readFileSync(file, "utf8"), lines.join("\r\n"));
    await until(() => journalFiles(dir).length === 0, "the journal to be removed");
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("a large file that changed since the crash is not edited without asking", async () => {
  const dir = tempProfile("kladde-large-conflict");
  settingsFor(dir);
  const file = writeFixture(dir, "conflict.txt", fixture());
  await editAndCrash(9392, dir, file);
  // Another program appends to the file while Kladde is not running.
  appendFileSync(file, "appended later\r\n");

  let app = await launch({ port: 9393, profile: dir });
  try {
    await app.waitFor(`document.querySelector('.banner')`, 10000);
    assert.match(await app.eval(`document.querySelector('.banner').textContent`), /changed since/);
    await waitIndexed(app);
    // Nothing was applied, and typing is refused until the user decides.
    await shownIs(app, [row(0)]);
    await focusView(app);
    await app.type("nope");
    await shownIs(app, [row(0)]);
    assert.ok(journalFiles(dir).length > 0);
  } finally {
    await app.kill();
  }

  // Apply anyway: the edits come back, and saving keeps what was appended meanwhile (after the document).
  app = await launch({ port: 9345, profile: dir });
  try {
    await app.waitFor(`document.querySelector('.banner')`, 10000);
    await app.eval(`[...document.querySelectorAll('.banner button')].find((b) => b.textContent === 'Apply anyway').click()`);
    await app.waitFor(`!document.querySelector('.banner') && document.querySelector('.large .line .text')?.textContent.startsWith('ONE ')`, 10000);
    await focusView(app);
    await app.key("Ctrl+S");
    await saved(app);
    assert.equal(readFileSync(file, "utf8"), editedLines().join("\r\n") + "appended later\r\n");
    await until(() => journalFiles(dir).length === 0, "the journal to be removed");
  } finally {
    await app.kill();
  }

  // Discard: the journal is dropped and the file as it is on disk stays.
  await editAndCrash(9397, dir, file);
  appendFileSync(file, "again\r\n");
  const before = readFileSync(file, "utf8");
  app = await launch({ port: 9391, profile: dir });
  try {
    await app.waitFor(`document.querySelector('.banner')`, 10000);
    await app.eval(`[...document.querySelectorAll('.banner button')].find((b) => b.textContent === 'Discard my changes').click()`);
    await app.waitFor(`!document.querySelector('.banner') && !document.querySelector('.tab.dirty')`, 10000);
    await until(() => journalFiles(dir).length === 0, "the journal to be removed");
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("a large file that moves while it has unsaved edits is not touched", async () => {
  const dir = tempProfile("kladde-large-moved");
  settingsFor(dir);
  const file = writeFixture(dir, "moved.txt", fixture());
  const app = await launch({ port: 9398, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.large .line')`, 10000);
    await waitIndexed(app);
    await focusView(app);
    await app.key("Ctrl+Home");
    await app.type("X");
    assert.deepEqual(await dirtyTabs(app), ["moved.txt"]);
    // The original is protected against writers while the edits refer to it (Windows).
    if (process.platform === "win32") assert.throws(() => appendFileSync(file, "more\r\n"));

    // Moved away: the tab warns instead of reopening or following anything, and keeps its edits.
    renameSync(file, join(dir, "elsewhere.txt"));
    await app.waitFor(`document.querySelector('.banner')?.textContent.includes('deleted or moved')`, 10000);
    assert.deepEqual(await dirtyTabs(app), ["moved.txt"]);
    await shownIs(app, [`X${row(0)}`]);

    // Saving writes the document to the old path again; the moved copy is still the unedited original.
    await app.eval(`[...document.querySelectorAll('.banner button')].find((b) => b.textContent === 'Keep in editor').click()`);
    await focusView(app);
    await app.key("Ctrl+S");
    await saved(app);
    assert.equal(readFileSync(file, "utf8"), "X" + fixture());
    assert.equal(readFileSync(join(dir, "elsewhere.txt"), "utf8"), fixture());
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});
