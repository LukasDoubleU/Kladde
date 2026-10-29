// Zero data loss: unsaved text survives a crash (kill), a normal close and continuous typing, and
// saving writes the file. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-hot-exit");
const files = join(profile, "files");
mkdirSync(files, { recursive: true });
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls a condition on the Node side (for things only the file system knows). */
async function until(condition, what, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The current backup texts in a profile (not the older versions "<id>.<n>.txt"). */
function backups(dir) {
  const folder = join(dir, "data", "backup");
  if (!existsSync(folder)) return [];
  // Kladde prunes and rotates backups while the test reads them: a file can vanish between listing and reading.
  return readdirSync(folder)
    .filter((n) => /^[^.]+\.txt$/.test(n))
    .flatMap((n) => {
      try {
        return [readFileSync(join(folder, n), "utf8")];
      } catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
      }
    });
}

const hasBackup = (dir, needle) => backups(dir).some((t) => t.includes(needle));

const focusEditor = (app) => app.eval("document.querySelector('.cm-content').focus(), true");

const activeIs = (title) => `document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(title)}`;

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

/** Runs the command that restores an older backup via the command palette. */
async function runRestoreCommand(app) {
  await app.key("Ctrl+Shift+P");
  await app.waitFor("document.querySelector('.picker input')");
  await app.type("older backup");
  await app.waitFor("document.querySelector('.picker [role=option]')");
  await app.key("Enter");
}

test("unsaved edits survive a crash, the file on disk stays unchanged", async () => {
  const dir = tempProfile("kladde-crash");
  const file = writeFixture(files, "crash.txt", "original\n");
  let app = await launch({ port: 9344, profile: dir, files: [file] });
  try {
    await app.waitFor(activeIs("crash.txt"));
    await focusEditor(app);
    await app.type("edited ");
    await app.key("Ctrl+T");
    await app.type("scratch note");
    await until(() => hasBackup(dir, "edited ") && hasBackup(dir, "scratch note"), "the backups");
  } finally {
    await app.kill();
  }

  app = await launch({ port: 9344, profile: dir });
  try {
    await app.waitFor("document.querySelectorAll('.tab').length === 2");
    let state = await app.state();
    assert.deepEqual(state.tabs, ["crash.txt", "new 1"]);
    assert.deepEqual(state.dirty, ["crash.txt", "new 1"]);
    assert.match(state.text, /scratch note/);
    await openTab(app, "crash.txt");
    state = await app.state();
    assert.match(state.text, /edited original/);
    assert.equal(readFileSync(file, "utf8"), "original\n");
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("continuous typing is backed up without a pause", async () => {
  const dir = tempProfile("kladde-typing");
  let app = await launch({ port: 9354, profile: dir });
  const chunks = ["alpha ", "bravo ", "charlie ", "delta ", "echo ", "foxtrot "];
  try {
    await focusEditor(app);
    // Pauses shorter than the old one-second debounce, which never fired while typing went on.
    for (const chunk of chunks) {
      await app.type(chunk);
      await sleep(400);
    }
    await sleep(200); // about 0.6 s after the last chunk
  } finally {
    await app.kill();
  }

  app = await launch({ port: 9354, profile: dir });
  try {
    await app.waitFor("document.querySelector('.cm-content')?.innerText.includes('foxtrot')");
    const { text } = await app.state();
    for (const chunk of chunks) assert.ok(text.includes(chunk.trim()), `missing "${chunk.trim()}" in "${text}"`);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("closing the window restores unsaved text too", async () => {
  const dir = tempProfile("kladde-close");
  const file = writeFixture(files, "close.txt", "disk\n");
  let app = await launch({ port: 9355, profile: dir, files: [file] });
  try {
    await app.waitFor(activeIs("close.txt"));
    await focusEditor(app);
    await app.type("typed before closing ");
    await app.key("Ctrl+T");
    await app.type("untitled text");
  } finally {
    await app.close();
  }

  app = await launch({ port: 9355, profile: dir });
  try {
    await app.waitFor("document.querySelectorAll('.tab').length === 2");
    const state = await app.state();
    assert.deepEqual(state.dirty, ["close.txt", "new 1"]);
    assert.match(state.text, /untitled text/);
    await openTab(app, "close.txt");
    assert.match((await app.state()).text, /typed before closing disk/);
    assert.equal(readFileSync(file, "utf8"), "disk\n");
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("Ctrl+S writes the file in place and clears the unsaved marker", async () => {
  const dir = tempProfile("kladde-save");
  const file = writeFixture(files, "save.txt", "line\n");
  let app = await launch({ port: 9356, profile: dir, files: [file] });
  try {
    await app.waitFor(activeIs("save.txt"));
    await focusEditor(app);
    await app.type("saved ");
    await app.waitFor("document.querySelector('.tab.dirty')");
    await until(() => hasBackup(dir, "saved "), "the backup");

    await app.key("Ctrl+S");
    await app.waitFor("!document.querySelector('.tab.dirty')");
    assert.match(readFileSync(file, "utf8"), /^saved line\r?\n$/);
    // The temporary file of the safe save is gone, and the backup of a saved tab is pruned.
    assert.deepEqual(readdirSync(files).filter((n) => n.startsWith("save")), ["save.txt"]);
    await until(() => backups(dir).length === 0, "the backup to be pruned");
  } finally {
    await app.kill();
  }

  app = await launch({ port: 9356, profile: dir });
  try {
    await app.waitFor(activeIs("save.txt"));
    const state = await app.state();
    assert.deepEqual(state.dirty, []);
    assert.match(state.text, /saved line/);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("an older backup opens in a new tab and leaves the current one alone", async () => {
  const dir = tempProfile("kladde-versions");
  const app = await launch({ port: 9357, profile: dir });
  try {
    await focusEditor(app);
    await app.type("first draft");
    await until(() => hasBackup(dir, "first draft"), "the first backup");
    await app.type(" and more");
    await until(() => hasBackup(dir, "and more"), "the second backup");

    await runRestoreCommand(app);
    // The picker now lists the versions of the tab; take the newest.
    await app.waitFor("document.querySelector('.picker')?.textContent.includes('ago')");
    await app.key("Enter");

    await app.waitFor("document.querySelectorAll('.tab').length === 2");
    const state = await app.state();
    assert.equal(state.active, "new 2");
    assert.equal(state.text.trim(), "first draft");
    assert.deepEqual(state.dirty, ["new 1", "new 2"]);
    await openTab(app, "new 1");
    assert.equal((await app.state()).text.trim(), "first draft and more");
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("restoring an older backup without versions shows a notice", async () => {
  const app = await launch({ port: 9358 });
  try {
    await focusEditor(app);
    await app.type("only one state");
    await runRestoreCommand(app);
    await app.waitFor("document.querySelector('.notice span')");
    const state = await app.state();
    assert.match(state.notice, /no older backups/);
    assert.equal(state.tabs.length, 1);
  } finally {
    await app.kill();
    await removeProfile(app.profile);
  }
});
