// "Move to Recycle Bin" (issue #29): the tab's context menu and Ctrl+Shift+Delete, the tab closing, the notice
// with Restore (the file back with the same bytes, the tab at its old place), the question for unsaved changes,
// a location that cannot be recycled (nothing is deleted), a path that is taken when Restore is pressed, a bin
// that was emptied, every tab kind, a file that is already gone, and a restart after the move (hot exit).
//
// The real Recycle Bin is the user's: the harness gives every app KLADDE_RECYCLE_DIR=<profile>/recycle, which
// makes the move go into that folder (isolated profile only; the Rust side never reaches the real bin from an
// isolated profile). The real thing is covered by `cargo test real_recycle_and_restore -- --ignored`.
// Needs a debug build:
//   npx tauri build --debug --no-bundle && node --test tests/e2e/recycle.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";
import { makeDocx } from "./docx-fixtures.mjs";

const profile = tempProfile("kladde-recycle");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A folder of its own for the files of one test. */
function folder(name) {
  const dir = join(profile, "files", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** What "Move to Recycle Bin" has put into the test profile's folder (the app's own file names). */
const recycled = (dir) => (existsSync(join(dir, "recycle")) ? readdirSync(join(dir, "recycle")) : []);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Runs a body with Kladde started on the given files and its own profile folder. */
async function session({ port, paths, env = {}, settings, dir = tempProfile("kladde-recycle-run") }, body) {
  if (settings) writeFixture(join(dir, "data"), "settings.json", JSON.stringify(settings));
  const app = await launch({ port, profile: dir, files: paths, env });
  try {
    await body(app, dir);
  } finally {
    await app.kill().catch(() => {});
    await removeProfile(dir);
  }
}

const tabs = (app) => app.eval(`[...document.querySelectorAll('.tab .title')].map((t) => t.textContent)`);
const notice = (app) =>
  app.eval(`({ text: document.querySelector('.notice span')?.textContent ?? null, action: document.querySelector('.notice .action')?.textContent ?? null, error: !!document.querySelector('.notice.error') })`);

async function waitNotice(app, includes) {
  await app.waitFor(`document.querySelector('.notice span')?.textContent.includes(${JSON.stringify(includes)})`);
}

/** Opens the context menu of the tab with this title (the same event a right click makes). */
async function openMenu(app, title) {
  await app.eval(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.title')?.textContent === ${JSON.stringify(title)});
    const r = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
  })()`);
  await app.waitFor(`document.querySelector('.menu')`);
}

const menuItems = (app) =>
  app.eval(`[...document.querySelectorAll('.menu button')].map((b) => ({ label: b.textContent, disabled: b.disabled }))`);

async function clickMenuItem(app, label) {
  await app.eval(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
}

/** Recycles a tab through its context menu. */
async function recycleViaMenu(app, title) {
  await openMenu(app, title);
  await clickMenuItem(app, "Move to Recycle Bin");
}

async function pressRestore(app) {
  await app.waitFor(`document.querySelector('.notice .action')?.textContent === 'Restore'`);
  await app.click(".notice .action");
}

async function activate(app, title) {
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

test("the context menu moves the file, closes the tab, and Restore brings both back in place", async () => {
  const dir = folder("menu");
  const bytes = {
    "a.txt": Buffer.from("alpha\r\n"),
    "b.txt": Buffer.from([0x62, 0x65, 0x74, 0x61, 0x0d, 0x0a, 0xc3, 0xa4, 0xe2, 0x82, 0xac, 0x0a]), // mixed line breaks, UTF-8
    "c.txt": Buffer.from("gamma"),
  };
  for (const [name, content] of Object.entries(bytes)) writeFileSync(join(dir, name), content);
  await session({ port: 9461, paths: Object.keys(bytes).map((n) => join(dir, n)) }, async (app, data) => {
    assert.deepEqual(await tabs(app), ["a.txt", "b.txt", "c.txt"]);

    // The item follows "Reveal in Explorer"; a tab with a file offers it.
    await openMenu(app, "b.txt");
    const items = (await menuItems(app)).map((i) => i.label);
    assert.equal(items[items.indexOf("Reveal in Explorer") + 1], "Move to Recycle Bin");
    assert.equal((await menuItems(app)).find((i) => i.label === "Move to Recycle Bin").disabled, false);
    await clickMenuItem(app, "Move to Recycle Bin");

    await waitNotice(app, "Moved b.txt to the Recycle Bin.");
    assert.equal(existsSync(join(dir, "b.txt")), false, "the file left its folder");
    assert.equal(recycled(data).length, 1);
    assert.deepEqual(readFileSync(join(data, "recycle", recycled(data)[0])), bytes["b.txt"], "moved, not changed");
    assert.deepEqual(await tabs(app), ["a.txt", "c.txt"]);
    const shown = await notice(app);
    assert.equal(shown.action, "Restore");
    assert.equal(shown.error, false);
    // Not offered as "Reopen closed tab": the file is not there.
    await app.key("Ctrl+Shift+T");
    await sleep(300);
    assert.deepEqual(await tabs(app), ["a.txt", "c.txt"]);

    await pressRestore(app);
    await app.waitFor(`[...document.querySelectorAll('.tab .title')].map((t) => t.textContent).join() === 'a.txt,b.txt,c.txt'`);
    assert.deepEqual(readFileSync(join(dir, "b.txt")), bytes["b.txt"], "the same bytes");
    assert.equal(recycled(data).length, 0);
    assert.equal((await app.state()).active, "b.txt", "the restored tab is active");
    assert.match((await app.state()).text, /beta/);

    // The shortcut does the same for the active tab. It is a command with an id, so it shows in the palette.
    await app.key("Ctrl+Shift+Delete");
    await waitNotice(app, "Moved b.txt to the Recycle Bin.");
    assert.equal(existsSync(join(dir, "b.txt")), false);
    assert.deepEqual(await tabs(app), ["a.txt", "c.txt"]);
    await pressRestore(app);
    await app.waitFor(`[...document.querySelectorAll('.tab .title')].map((t) => t.textContent).join() === 'a.txt,b.txt,c.txt'`);
    assert.deepEqual(readFileSync(join(dir, "b.txt")), bytes["b.txt"]);

    // The last tab of the strip keeps its place too.
    await activate(app, "c.txt");
    await app.key("Ctrl+Shift+Delete");
    await waitNotice(app, "Moved c.txt to the Recycle Bin.");
    assert.equal((await app.state()).active, "b.txt", "the neighbour takes over");
    await pressRestore(app);
    await app.waitFor(`[...document.querySelectorAll('.tab .title')].map((t) => t.textContent).join() === 'a.txt,b.txt,c.txt'`);
    assert.deepEqual(readFileSync(join(dir, "c.txt")), bytes["c.txt"]);
    assert.equal((await app.state()).active, "c.txt");

    // The command is in the palette with its key.
    await app.key("Ctrl+Shift+P");
    await app.type("recycle");
    await app.waitFor(`document.querySelector('.picker')?.textContent.includes('Move to Recycle Bin')`);
    assert.match(await app.eval(`document.querySelector('.picker').textContent`), /Ctrl\+Shift\+Delete/);
    await app.key("Escape");
  });
});

test("an untitled tab has nothing to move: the item is disabled and the key does nothing", async () => {
  const dir = folder("untitled");
  writeFileSync(join(dir, "a.txt"), "alpha");
  await session({ port: 9461, paths: [join(dir, "a.txt")] }, async (app) => {
    await app.key("Ctrl+N");
    await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === 'new 1'`);
    await openMenu(app, "new 1");
    assert.equal((await menuItems(app)).find((i) => i.label === "Move to Recycle Bin").disabled, true);
    await app.key("Escape");
    await app.key("Ctrl+Shift+Delete");
    await sleep(400);
    assert.deepEqual(await tabs(app), ["a.txt", "new 1"]);
    assert.equal((await notice(app)).text, null);
    // And not in the palette while the tab has no file.
    await app.key("Ctrl+Shift+P");
    await app.type("recycle");
    await sleep(300);
    assert.equal(await app.eval(`document.querySelector('.picker')?.textContent.includes('Move to Recycle Bin') ?? false`), false);
    await app.key("Escape");
    assert.equal(existsSync(join(dir, "a.txt")), true);
  });
});

test("unsaved changes: Cancel is the default and keeps everything; confirming moves the file and drops the changes", async () => {
  const dir = folder("dirty");
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "b.txt"), "beta");
  const data = tempProfile("kladde-recycle-dirty");
  try {
    await session({ port: 9462, paths: [join(dir, "a.txt"), join(dir, "b.txt")], dir: data }, async (app) => {
      await activate(app, "a.txt");
      await app.eval(`document.querySelector('.cm-content').focus()`);
      await app.type(" edited");
      await app.waitFor(`document.querySelector('.tab.dirty')`);

      await app.key("Ctrl+Shift+Delete");
      await app.waitFor(`document.querySelector('.dialog .message')`);
      const dialog = await app.eval(`({ message: document.querySelector('.dialog .message').textContent, detail: document.querySelector('.dialog .detail')?.textContent, buttons: [...document.querySelectorAll('.dialog button')].map((b) => ({ label: b.textContent, primary: b.classList.contains('primary'), focused: b === document.activeElement })) })`);
      assert.equal(dialog.message, "a.txt has unsaved changes. Move the file to the Recycle Bin anyway?");
      assert.equal(dialog.detail, "The unsaved changes are lost.");
      assert.deepEqual(
        dialog.buttons.map((b) => b.label),
        ["Move to Recycle Bin", "Cancel"],
      );
      assert.equal(dialog.buttons.find((b) => b.primary).label, "Cancel", "Cancel is the default button");
      assert.equal(dialog.buttons.find((b) => b.focused)?.label, "Cancel");

      // Enter takes the default: nothing happens.
      await app.key("Enter");
      await app.waitFor(`!document.querySelector('.dialog')`);
      assert.deepEqual(await tabs(app), ["a.txt", "b.txt"]);
      assert.deepEqual((await app.state()).dirty, ["a.txt"]);
      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha");
      assert.equal(recycled(data).length, 0);
      assert.equal((await notice(app)).text, null);

      // Escape cancels as well.
      await app.key("Ctrl+Shift+Delete");
      await app.waitFor(`document.querySelector('.dialog .message')`);
      await app.key("Escape");
      await app.waitFor(`!document.querySelector('.dialog')`);
      assert.deepEqual(await tabs(app), ["a.txt", "b.txt"]);

      // A clean tab moves without asking.
      await activate(app, "b.txt");
      await app.key("Ctrl+Shift+Delete");
      await waitNotice(app, "Moved b.txt to the Recycle Bin.");
      assert.equal(await app.eval(`!!document.querySelector('.dialog')`), false);
      await pressRestore(app);
      await app.waitFor(`document.querySelector('.tab .title') && [...document.querySelectorAll('.tab .title')].map((t) => t.textContent).join() === 'a.txt,b.txt'`);

      // Confirming moves the file as it is on disk, without the edit; the unsaved text goes with the tab.
      await activate(app, "a.txt");
      await app.key("Ctrl+Shift+Delete");
      await app.waitFor(`document.querySelector('.dialog .message')`);
      await app.eval(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Move to Recycle Bin').click()`);
      await waitNotice(app, "Moved a.txt to the Recycle Bin.");
      assert.deepEqual(await tabs(app), ["b.txt"]);
      assert.equal(existsSync(join(dir, "a.txt")), false);
      assert.equal(readFileSync(join(data, "recycle", recycled(data)[0]), "utf8"), "alpha", "the file is moved as it was saved");
    });
  } finally {
    await removeProfile(data);
  }
});

test("after a crash or a normal exit the recycled tab does not come back, and its backup is gone", async () => {
  const dir = folder("restart");
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "b.txt"), "beta");
  const data = tempProfile("kladde-recycle-restart");
  try {
    for (const way of ["kill", "close"]) {
      writeFileSync(join(dir, "a.txt"), "alpha");
      let app = await launch({ port: way === "kill" ? 9463 : 9464, profile: data, files: [join(dir, "a.txt"), join(dir, "b.txt")] });
      await app.waitFor(`document.querySelectorAll('.tab').length >= 2`);
      await activate(app, "a.txt");
      await app.eval(`document.querySelector('.cm-content').focus()`);
      await app.type(" unsaved");
      // A backup of the edit is on the disk, so the session lists the tab with it.
      const sessionFile = join(data, "data", "session.json");
      const listed = () => {
        try {
          return JSON.parse(readFileSync(sessionFile, "utf8")).tabs.some((t) => t.title === "a.txt" && t.hasBackup);
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && !listed(); i++) await sleep(50);
      assert.ok(listed(), "the edit was backed up");
      await app.key("Ctrl+Shift+Delete");
      await app.waitFor(`document.querySelector('.dialog .message')`);
      await app.eval(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Move to Recycle Bin').click()`);
      await waitNotice(app, "Moved a.txt to the Recycle Bin.");
      // The session is written at once, not by the throttle: wait for it, then end the app.
      const gone = () => {
        try {
          return !JSON.parse(readFileSync(sessionFile, "utf8")).tabs.some((t) => t.title === "a.txt");
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && !gone(); i++) await sleep(50);
      assert.ok(gone(), "the session no longer names the recycled tab");
      if (way === "kill") await app.kill();
      else await app.close();

      app = await launch({ port: way === "kill" ? 9465 : 9466, profile: data });
      assert.deepEqual(await tabs(app), ["b.txt"], `after ${way}`);
      assert.equal(existsSync(join(dir, "a.txt")), false);
      assert.equal(readdirSync(join(data, "data", "backup")).filter((n) => n.endsWith(".txt")).length, 0, "no backup left");
      // Put the file back for the next round (the test folder is not Kladde's).
      const kept = join(data, "recycle", recycled(data).at(-1));
      writeFileSync(join(dir, "a.txt"), readFileSync(kept));
      rmSync(kept);
      await app.kill();
    }
  } finally {
    await removeProfile(data);
  }
});

test("a location that cannot be recycled: nothing is deleted, the tab stays and Kladde says so", async () => {
  const dir = folder("refused");
  writeFileSync(join(dir, "a.txt"), "alpha");
  await session({ port: 9467, paths: [join(dir, "a.txt")], env: { KLADDE_RECYCLE_REFUSE: "1" } }, async (app, data) => {
    await app.key("Ctrl+Shift+Delete");
    await waitNotice(app, "Could not move a.txt to the Recycle Bin");
    const shown = await notice(app);
    assert.equal(shown.error, true);
    assert.match(shown.text, /no Recycle Bin/);
    assert.match(shown.text, /Nothing was deleted/);
    assert.equal(shown.action, null, "no Restore: nothing was moved");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha");
    assert.deepEqual(await tabs(app), ["a.txt"]);
    assert.equal(recycled(data).length, 0);
    // The menu does the same.
    await recycleViaMenu(app, "a.txt");
    await waitNotice(app, "Could not move a.txt to the Recycle Bin");
    assert.equal(existsSync(join(dir, "a.txt")), true);
  });
});

test("Restore never overwrites, and says so when the file is gone from the bin", async () => {
  const dir = folder("occupied");
  writeFileSync(join(dir, "a.txt"), "original");
  writeFileSync(join(dir, "b.txt"), "second");
  await session({ port: 9461, paths: [join(dir, "a.txt"), join(dir, "b.txt")] }, async (app, data) => {
    await activate(app, "a.txt");
    await app.key("Ctrl+Shift+Delete");
    await waitNotice(app, "Moved a.txt to the Recycle Bin.");
    // Something else took the name meanwhile.
    writeFileSync(join(dir, "a.txt"), "someone else's file");
    await pressRestore(app);
    await waitNotice(app, "Could not restore a.txt");
    const shown = await notice(app);
    assert.equal(shown.error, true);
    assert.match(shown.text, /already exists/);
    assert.match(shown.text, /Nothing was overwritten/);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "someone else's file", "the newcomer is untouched");
    assert.equal(recycled(data).length, 1, "the recycled file stays where it is");
    assert.deepEqual(await tabs(app), ["b.txt"], "no tab for the file that was not restored");

    // The bin was emptied meanwhile.
    await app.key("Ctrl+Shift+Delete");
    await waitNotice(app, "Moved b.txt to the Recycle Bin.");
    for (const name of recycled(data)) if (readFileSync(join(data, "recycle", name), "utf8") === "second") rmSync(join(data, "recycle", name));
    await pressRestore(app);
    await waitNotice(app, "Could not restore b.txt");
    assert.match((await notice(app)).text, /no longer in the Recycle Bin/);
    assert.equal(existsSync(join(dir, "b.txt")), false);
  });
});

test("every kind of tab with a file: large, image and Word document", async () => {
  const dir = folder("kinds");
  const large = Buffer.from(Array.from({ length: 3000 }, (_, i) => `line ${i} of the large file`).join("\n"));
  const docx = Buffer.from(await makeDocx({ pages: 2 }));
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "big.log"), large);
  writeFileSync(join(dir, "pic.png"), PNG);
  writeFileSync(join(dir, "doc.docx"), docx);
  const paths = ["a.txt", "big.log", "pic.png", "doc.docx"].map((n) => join(dir, n));
  await session({ port: 9462, paths, settings: { largeFileThresholdMB: 0.05 } }, async (app, data) => {
    const order = ["a.txt", "big.log", "pic.png", "doc.docx"];
    assert.deepEqual(await tabs(app), order);
    for (const [name, bytes, selector] of [
      ["big.log", large, ".large"],
      ["pic.png", PNG, ".image-view img"],
      ["doc.docx", docx, ".document-view"],
    ]) {
      await activate(app, name);
      await app.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
      await recycleViaMenu(app, name);
      await waitNotice(app, `Moved ${name} to the Recycle Bin.`);
      assert.equal(existsSync(join(dir, name)), false, `${name} left its folder`);
      assert.deepEqual(await tabs(app), order.filter((n) => n !== name));
      assert.deepEqual(readFileSync(join(data, "recycle", recycled(data)[0])), bytes);
      await pressRestore(app);
      await app.waitFor(`[...document.querySelectorAll('.tab .title')].map((t) => t.textContent).join() === ${JSON.stringify(order.join())}`);
      assert.deepEqual(readFileSync(join(dir, name)), bytes, `${name}: the same bytes`);
      assert.equal(recycled(data).length, 0);
      assert.equal((await app.state()).active, name);
      await app.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
    }
  });
});

test("a tab whose file is already gone cannot be moved", async () => {
  const dir = folder("gone");
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "b.txt"), "beta");
  await session({ port: 9463, paths: [join(dir, "a.txt"), join(dir, "b.txt")] }, async (app, data) => {
    await activate(app, "b.txt");
    rmSync(join(dir, "b.txt"));
    // The "deleted or moved" state, found by the poll of the active tab.
    await app.waitFor(`document.querySelector('.tab.active .badge.warn')`, 10000);
    await openMenu(app, "b.txt");
    assert.equal((await menuItems(app)).find((i) => i.label === "Move to Recycle Bin").disabled, true);
    await app.key("Escape");
    await app.key("Ctrl+Shift+Delete");
    await sleep(400);
    assert.deepEqual(await tabs(app), ["a.txt", "b.txt"]);
    assert.equal((await notice(app)).action, null);
    assert.equal(recycled(data).length, 0);
    // Another tab is unaffected.
    await openMenu(app, "a.txt");
    assert.equal((await menuItems(app)).find((i) => i.label === "Move to Recycle Bin").disabled, false);
    await app.key("Escape");
  });
});
