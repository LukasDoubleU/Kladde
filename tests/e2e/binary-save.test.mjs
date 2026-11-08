// Files that are not text (issue #20): saving a tab without changes writes nothing, binary and lossy files open
// read-only until "Edit anyway", the first save after that asks, and a crash restores edited ones editable.
// The editor shows decoded text and saves it encoded again, which cannot give back the bytes of a .docx or a
// .pdf (line breaks are normalized), so these tests compare bytes (SHA-256) of the files on disk. Needs a debug build:
//   npx tauri build --debug --no-bundle && node --test tests/e2e/binary-save.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";
import { makeZip } from "./zip.mjs";

const profile = tempProfile("kladde-binary-save");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function until(condition, what, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** 4 KB of deterministic bytes with NUL bytes, lone CRs, CRLFs and bytes that are no UTF-8. */
function blob(seed = 1, size = 4096) {
  const bytes = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (x >> 16) & 0xff;
  }
  bytes.set([0x00, 0x0d, 0x41, 0x0d, 0x0a, 0x0d, 0x00, 0xff, 0xfe, 0x0d], 16);
  return bytes;
}

/** Bytes that differ in a text view: how many CR bytes are not followed by LF (what the old save turned into LF). */
const loneCrs = (bytes) => bytes.reduce((n, b, i) => n + (b === 0x0d && bytes[i + 1] !== 0x0a ? 1 : 0), 0);

/** A zip with the look of a .docx: stored entries, XML with a lone CR in it, binary data. */
function docxLike() {
  return makeZip([
    ["[Content_Types].xml", '<?xml version="1.0"?>\r<Types>\r\n</Types>\r'],
    ["word/document.xml", Buffer.concat([Buffer.from("<w:document>"), blob(7, 1500), Buffer.from("</w:document>")])],
    ["docProps/core.xml", "<cp:coreProperties/>"],
  ]);
}

const activeIs = (title) => `document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(title)}`;
const focusEditor = (app) => app.eval("document.querySelector('.cm-content').focus(), true");
const banner = (app) => app.eval(`document.querySelector('.banner.readonly')?.textContent ?? null`);
const footer = (app) => app.eval(`document.querySelector('footer')?.textContent ?? ''`);
const dialog = (app) => app.eval(`document.querySelector('.dialog .message')?.textContent ?? null`);
const clickButton = (app, selector, label) =>
  app.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(), true`);
const editAnyway = (app) => clickButton(app, ".banner.readonly button", "Edit anyway");
const dirtyTabs = async (app) => (await app.state()).dirty;

const BANNER = "This file is not text. Kladde opened it read-only, so saving cannot change its bytes.";

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
  await app.waitFor(activeIs(title));
}

/** Typing, a printable key, Enter and Backspace in a read-only tab change nothing. */
async function typeIntoReadOnly(app) {
  const before = (await app.state()).text;
  await app.type("typed text");
  await app.key("x");
  await app.key("Enter");
  await app.key("Backspace");
  await app.key("Delete");
  await sleep(150);
  const state = await app.state();
  assert.equal(state.text, before, "a read-only tab does not change");
  assert.deepEqual(state.dirty, []);
}

test("Ctrl+S on unchanged binary, zip and mixed line ending files leaves their bytes alone", async () => {
  const dir = tempProfile("kladde-binary-save-same");
  const bin = writeFixture(dir, "blob.bin", blob());
  const zip = writeFixture(dir, "report.zip", docxLike());
  const mixed = writeFixture(dir, "mixed.txt", "crlf one\r\nlf two\nthree\rfour\r\nfive\r\n");
  const original = [bin, zip, mixed].map((f) => readFileSync(f));
  assert.ok(loneCrs(original[0]) > 0 && loneCrs(original[1]) > 0, "the fixtures have lone CR bytes");
  const stamps = [bin, zip, mixed].map((f) => statSync(f).mtimeMs);
  const app = await launch({ port: 9413, profile: dir, files: [bin, zip, mixed] });
  try {
    await app.waitFor(`document.querySelectorAll('.tab').length === 3`);

    // The binary file: read-only, with the banner, and saving it leaves it as it is.
    await openTab(app, "blob.bin");
    assert.equal(await banner(app), `${BANNER} Edit anyway`);
    assert.match(await footer(app), /binary/);
    assert.match(await footer(app), /read-only/);
    await focusEditor(app);
    await typeIntoReadOnly(app);
    await app.key("Ctrl+S");
    await app.key("Ctrl+Alt+Shift+S");
    await sleep(300);
    assert.equal(await dialog(app), null, "nothing to confirm when nothing is written");
    assert.deepEqual(await dirtyTabs(app), []);
    assert.equal(sha(readFileSync(bin)), sha(original[0]));
    assert.equal(statSync(bin).mtimeMs, stamps[0], "the file was not even touched");

    // Searching works, replacing does not exist in a read-only tab.
    await app.key("Ctrl+F");
    await app.waitFor(`document.querySelector('.cm-search')`);
    assert.equal(await app.eval(`!!document.querySelector('.cm-search [name=replaceAll]')`), false);
    await app.key("Escape");

    // The .docx-like zip.
    await openTab(app, "report.zip");
    assert.equal(await banner(app), `${BANNER} Edit anyway`);
    await app.key("Ctrl+S");
    await sleep(300);
    assert.equal(sha(readFileSync(zip)), sha(original[1]));
    assert.equal(statSync(zip).mtimeMs, stamps[1]);

    // A text file with mixed line endings: no banner, nothing written either.
    await openTab(app, "mixed.txt");
    assert.equal(await banner(app), null);
    await focusEditor(app);
    await app.key("Ctrl+S");
    await sleep(300);
    assert.equal(sha(readFileSync(mixed)), sha(original[2]));
    assert.equal(statSync(mixed).mtimeMs, stamps[2]);

    // Typing and deleting again ends where it started: the tab is clean and saving still writes nothing.
    await app.key("Ctrl+End");
    await app.type("zz");
    assert.deepEqual(await dirtyTabs(app), ["mixed.txt"]);
    await app.key("Backspace");
    await app.key("Backspace");
    await app.waitFor(`!document.querySelector('.tab.dirty')`);
    await app.key("Ctrl+S");
    await sleep(300);
    assert.equal(statSync(mixed).mtimeMs, stamps[2]);

    // A real edit is saved (and only then are the line endings normalized to the file's dominant one).
    await app.type("six");
    await app.key("Ctrl+S");
    await app.waitFor(`!document.querySelector('.tab.dirty')`);
    assert.equal(readFileSync(mixed, "utf8"), "crlf one\r\nlf two\r\nthree\r\nfour\r\nfive\r\nsix");
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("saving writes a file that was deleted meanwhile, even when the tab has no changes", async () => {
  const dir = tempProfile("kladde-binary-save-deleted");
  const file = writeFixture(dir, "gone.txt", "one\r\ntwo");
  const app = await launch({ port: 9414, profile: dir, files: [file] });
  try {
    await app.waitFor(activeIs("gone.txt"));
    await focusEditor(app);
    unlinkSync(file);
    await app.key("Ctrl+S");
    await until(() => existsSync(file), "the file to be written again");
    assert.equal(readFileSync(file, "utf8"), "one\r\ntwo");
    await app.waitFor(`!document.querySelector('.tab.dirty') && !document.querySelector('.banner')`);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("Edit anyway, then the first save asks once; Cancel keeps the tab unsaved", async () => {
  const dir = tempProfile("kladde-binary-save-edit");
  const bytes = blob(3);
  const file = writeFixture(dir, "edit.bin", bytes);
  // Latin-1 text: opens as ANSI, then reopened as UTF-8 it has bytes that are not valid there (lossy).
  const latin = Buffer.concat([Buffer.from('{"name":"caf'), Buffer.from([0xe9]), Buffer.from('","list":[1,2]}\n')]);
  const json = writeFixture(dir, "latin.json", latin);
  const app = await launch({ port: 9415, profile: dir, files: [file, json] });
  try {
    await app.waitFor(`document.querySelectorAll('.tab').length === 2`);
    await openTab(app, "edit.bin");
    await focusEditor(app);
    await typeIntoReadOnly(app);

    await editAnyway(app);
    await app.waitFor(`!document.querySelector('.banner.readonly')`);
    assert.doesNotMatch(await footer(app), /read-only/);
    await focusEditor(app);
    await app.key("Ctrl+Home");
    await app.type("EDIT");
    assert.deepEqual(await dirtyTabs(app), ["edit.bin"]);

    // Cancel: nothing is written and the tab stays unsaved.
    await app.key("Ctrl+S");
    await app.waitFor(`document.querySelector('.dialog')`);
    assert.match(await dialog(app), /Saving edit\.bin may change bytes that are not text/);
    await clickButton(app, ".dialog button", "Cancel");
    await app.waitFor(`!document.querySelector('.dialog')`);
    await sleep(200);
    assert.deepEqual(await dirtyTabs(app), ["edit.bin"]);
    assert.equal(sha(readFileSync(file)), sha(bytes));

    // Save anyway writes.
    await app.key("Ctrl+S");
    await app.waitFor(`document.querySelector('.dialog')`);
    await clickButton(app, ".dialog button", "Save anyway");
    await app.waitFor(`!document.querySelector('.tab.dirty')`, 10000);
    const written = readFileSync(file);
    assert.notEqual(sha(written), sha(bytes));
    assert.ok(written.includes("EDIT"));

    // Asked once: the next save goes through.
    await app.type("more");
    await app.key("Ctrl+S");
    await app.waitFor(`!document.querySelector('.tab.dirty')`, 10000);
    assert.equal(await dialog(app), null);
    assert.ok(readFileSync(file).includes("EDITmore"));

    // A lossy file (no NUL bytes, but not valid in its encoding) is read-only as well, also after a reload.
    await openTab(app, "latin.json");
    assert.equal(await banner(app), null, "valid as ANSI: a normal text tab");
    await app.key("Ctrl+Shift+P");
    await app.type("Change encoding");
    await app.waitFor(`document.querySelector('.picker [role=option]')`);
    await app.key("Enter");
    await app.waitFor(`[...document.querySelectorAll('.picker [role=option]')].some((o) => o.textContent.includes('Reopen with encoding'))`);
    await app.key("Enter");
    await app.waitFor(`[...document.querySelectorAll('.picker [role=option]')].some((o) => o.textContent.trim().startsWith('UTF-8'))`);
    await app.type("UTF-8");
    await app.waitFor(`document.querySelector('.picker [role=option]')?.textContent.trim().startsWith('UTF-8')`);
    await app.key("Enter");
    await app.waitFor(`document.querySelector('.banner.readonly')`);
    assert.match(await footer(app), /invalid bytes/);

    // Format JSON must not touch it, and neither must saving.
    const shown = (await app.state()).text;
    await app.key("Shift+Alt+F");
    await app.waitFor(`document.querySelector('.notice span')?.textContent.includes('read-only')`);
    assert.equal((await app.state()).text, shown);
    assert.deepEqual(await dirtyTabs(app), []);
    await app.key("Ctrl+S");
    await sleep(300);
    assert.equal(sha(readFileSync(json)), sha(latin));
    assert.equal(await dialog(app), null);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

const sessionTab = (dir, title) => {
  try {
    return JSON.parse(readFileSync(join(dir, "data", "session.json"), "utf8")).tabs.find((t) => t.title === title);
  } catch {
    return undefined;
  }
};
const backupTexts = (dir) => {
  const folder = join(dir, "data", "backup");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((n) => /^[^.]+\.txt$/.test(n))
    .flatMap((n) => {
      try {
        return [readFileSync(join(folder, n), "latin1")];
      } catch {
        return [];
      }
    });
};

test("a binary tab edited after Edit anyway comes back editable after a crash, an unedited one read-only", async () => {
  const dir = tempProfile("kladde-binary-save-crash");
  const edited = writeFixture(dir, "edited.bin", blob(11));
  const untouched = writeFixture(dir, "untouched.bin", blob(12));
  const originals = [readFileSync(edited), readFileSync(untouched)];
  let app = await launch({ port: 9416, profile: dir, files: [edited, untouched] });
  try {
    await app.waitFor(`document.querySelectorAll('.tab').length === 2`);
    await openTab(app, "edited.bin");
    await editAnyway(app);
    await focusEditor(app);
    await app.key("Ctrl+Home");
    await app.type("SURVIVOR");
    await until(() => sessionTab(dir, "edited.bin")?.hasBackup && backupTexts(dir).some((t) => t.includes("SURVIVOR")), "the backup");
  } finally {
    await app.kill();
  }
  assert.equal(sha(readFileSync(edited)), sha(originals[0]), "nothing was written by the crash");

  app = await launch({ port: 9417, profile: dir });
  try {
    await app.waitFor(`document.querySelectorAll('.tab').length === 2`);
    await openTab(app, "edited.bin");
    assert.deepEqual(await dirtyTabs(app), ["edited.bin"]);
    assert.equal(await banner(app), null, "restored edits are editable");
    assert.match((await app.state()).text, /SURVIVOR/);
    await focusEditor(app);
    await app.key("Ctrl+Home");
    await app.type("AGAIN");
    assert.match((await app.state()).text, /AGAIN/);

    // The user can save what was restored (after the one question).
    await app.key("Ctrl+S");
    await app.waitFor(`document.querySelector('.dialog')`);
    await clickButton(app, ".dialog button", "Save anyway");
    await app.waitFor(`!document.querySelector('.tab.dirty')`, 10000);
    const written = readFileSync(edited);
    assert.ok(written.includes("AGAINSURVIVOR"));

    // The tab that was never edited is read-only again, and untouched on disk.
    await openTab(app, "untouched.bin");
    assert.equal(await banner(app), `${BANNER} Edit anyway`);
    assert.deepEqual(await dirtyTabs(app), []);
    await focusEditor(app);
    await typeIntoReadOnly(app);
    assert.equal(sha(readFileSync(untouched)), sha(originals[1]));
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

// ---------------------------------------------------------------- the large file viewer

// Everything above 50 KB opens in the viewer.
function largeSettings(dir) {
  writeFixture(join(dir, "data"), "settings.json", JSON.stringify({ largeFileThresholdMB: 0.05 }));
}

/** 3000 lines with NUL bytes in the first of them: a binary file the viewer shows. */
function largeBinary() {
  const lines = Array.from({ length: 3000 }, (_, i) => `row ${i} payload ${"x".repeat(20)}`);
  lines[0] = "HEAD\x00\x01\x02 " + lines[0];
  return Buffer.from(lines.join("\r\n") + "\r\n", "latin1");
}

const firstLine = (app) => app.eval(`document.querySelector('.large .line .text')?.textContent ?? null`);
const focusView = (app) => app.eval(`document.querySelector('.large .input').focus(), true`);
const waitLarge = async (app) => {
  await app.waitFor(`document.querySelector('.large .line')`, 10000);
  await app.waitFor(`document.querySelector('.large') && !document.body.innerText.includes('Indexing')`, 10000);
};
const journalAdded = (dir) => {
  const folder = join(dir, "data", "backup");
  if (!existsSync(folder)) return null;
  for (const name of readdirSync(folder).filter((n) => n.endsWith(".large.json"))) {
    try {
      return JSON.parse(readFileSync(join(folder, name), "utf8")).addedLen;
    } catch {
      /* being replaced */
    }
  }
  return null;
};

test("a binary file in the large viewer is read-only until Edit anyway, and saving asks", async () => {
  const dir = tempProfile("kladde-binary-save-large");
  largeSettings(dir);
  const bytes = largeBinary();
  const file = writeFixture(dir, "big.bin", bytes);
  const stamp = statSync(file).mtimeMs;
  const app = await launch({ port: 9418, profile: dir, files: [file] });
  try {
    await waitLarge(app);
    assert.equal(await banner(app), `${BANNER} Edit anyway`);
    assert.match(await footer(app), /read-only/);
    const head = await firstLine(app);
    assert.match(head, /^HEAD/);

    // Typing, deleting and cutting do nothing; saving writes nothing.
    await focusView(app);
    await app.key("Ctrl+Home");
    await app.type("typed");
    await app.key("Delete");
    await app.key("Ctrl+D");
    await sleep(200);
    assert.equal(await firstLine(app), head);
    assert.deepEqual(await dirtyTabs(app), []);
    await app.key("Ctrl+S");
    await sleep(300);
    assert.equal(sha(readFileSync(file)), sha(bytes));
    assert.equal(statSync(file).mtimeMs, stamp);

    await editAnyway(app);
    await app.waitFor(`!document.querySelector('.banner.readonly')`);
    await focusView(app);
    await app.key("Ctrl+Home");
    await app.type("X");
    assert.deepEqual(await dirtyTabs(app), ["big.bin"]);

    await app.key("Ctrl+S");
    await app.waitFor(`document.querySelector('.dialog')`);
    assert.match(await dialog(app), /may change bytes that are not text/);
    await clickButton(app, ".dialog button", "Cancel");
    await app.waitFor(`!document.querySelector('.dialog')`);
    await sleep(200);
    assert.deepEqual(await dirtyTabs(app), ["big.bin"]);
    assert.equal(sha(readFileSync(file)), sha(bytes));

    await app.key("Ctrl+S");
    await app.waitFor(`document.querySelector('.dialog')`);
    await clickButton(app, ".dialog button", "Save anyway");
    await app.waitFor(`!document.querySelector('.tab.dirty')`, 10000);
    // The viewer writes untouched bytes exactly as they were: the only difference is the typed X.
    assert.equal(sha(readFileSync(file)), sha(Buffer.concat([Buffer.from("X"), bytes])));
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("a large binary file edited after Edit anyway comes back editable after a crash", async () => {
  const dir = tempProfile("kladde-binary-save-large-crash");
  largeSettings(dir);
  const bytes = largeBinary();
  const file = writeFixture(dir, "crash.bin", bytes);
  let app = await launch({ port: 9419, profile: dir, files: [file] });
  try {
    await waitLarge(app);
    await editAnyway(app);
    await focusView(app);
    await app.key("Ctrl+Home");
    await app.type("ONE ");
    await until(() => journalAdded(dir) === 4, "the journal of the edit");
  } finally {
    await app.kill();
  }
  assert.equal(sha(readFileSync(file)), sha(bytes));

  app = await launch({ port: 9413, profile: dir });
  try {
    await app.waitFor(`document.querySelector('.tab.dirty') && !document.querySelector('footer').textContent.includes('Restoring')`, 10000);
    await waitLarge(app);
    assert.equal(await banner(app), null, "restored edits are editable");
    assert.match(await firstLine(app), /^ONE HEAD/);
    await focusView(app);
    await app.key("Ctrl+Home");
    await app.type("M");
    assert.match(await firstLine(app), /^MONE HEAD/);
    await app.key("Ctrl+S");
    await app.waitFor(`document.querySelector('.dialog')`);
    await clickButton(app, ".dialog button", "Save anyway");
    await app.waitFor(`!document.querySelector('.tab.dirty')`, 10000);
    assert.equal(sha(readFileSync(file)), sha(Buffer.concat([Buffer.from("MONE "), bytes])));
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});
