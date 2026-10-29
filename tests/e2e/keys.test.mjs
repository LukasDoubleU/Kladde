// Keyboard shortcuts: the default keys, presets, chords, the shortcut editor and unbinding. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-keys");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts Kladde with a file open and optional settings.json / keybindings.json (objects), runs
 * `body(app, dataDir)` and always kills the app. The cursor starts at the beginning of the file.
 */
async function session({ port = 9350, name = "a.txt", text, settings, bindings }, body) {
  const dir = tempProfile("kladde-keys-run");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  if (settings) writeFileSync(join(data, "settings.json"), JSON.stringify(settings));
  if (bindings) writeFileSync(join(data, "keybindings.json"), JSON.stringify(bindings));
  const file = writeFixture(profile, name, text);
  const app = await launch({ port, profile: dir, files: [file] });
  try {
    await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(name)}`);
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Ctrl+Home");
    await body(app, data);
  } finally {
    await app.kill();
  }
}

const text = async (app) => (await app.state()).text.replace(/ /g, " ").replace(/\n+$/, "");
const status = (app) => app.eval("document.querySelector('footer').innerText");
const hint = (app) => app.eval("document.querySelector('footer .chord')?.textContent ?? null");
const keybindings = (data) => JSON.parse(readFileSync(join(data, "keybindings.json"), "utf8"));

/** Runs a command from the command palette by (part of) its name. */
async function palette(app, name) {
  await app.key("Ctrl+Shift+P");
  await app.waitFor("document.querySelector('.picker input')");
  await app.type(name);
  await app.waitFor("document.querySelector('.picker [role=option]')");
  await app.key("Enter");
}

/** Waits for a picker with the placeholder and chooses the entry that has the label. */
async function choose(app, placeholder, label) {
  await app.waitFor(`document.querySelector('.picker input')?.placeholder === ${JSON.stringify(placeholder)}`);
  await app.type(label);
  await app.waitFor(`document.querySelector('.picker [role=option]')?.textContent.includes(${JSON.stringify(label)})`);
  await app.key("Enter");
}

test("the command palette keeps the focus when it opens right after a tab switch", async () => {
  // Switching tabs hands the focus back to the editor one frame later. That used to take it from a palette
  // opened in between (a command after a slow start, a quick Ctrl+Tab, Ctrl+Shift+P), so typed text went
  // into the editor. Both keys run in one task here so that the frame cannot come first.
  const dir = tempProfile("kladde-keys-run");
  const files = ["one.txt", "two.txt"].map((name) => writeFixture(profile, name, name));
  const app = await launch({ port: 9351, profile: dir, files });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'two.txt'");
    const keydown = (key, code) =>
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, ctrlKey: true, shiftKey: ${key === "P"}, bubbles: true, cancelable: true }))`;
    await app.eval(`${keydown("Tab", "Tab")}, ${keydown("P", "KeyP")}, true`);
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'one.txt'");
    await app.waitFor("!!document.querySelector('.picker')");
    // Two frames: the one of the tab switch has certainly run by then.
    await app.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    assert.equal(await app.eval("document.activeElement?.matches('.picker input')"), true);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});

test("default keys: Ctrl+D deletes a line, CodeMirror's commands are actions", async () => {
  await session({ text: "one\ntwo\nthree\nfour\n" }, async (app) => {
    await app.key("Down");
    await app.key("Ctrl+D");
    assert.equal(await text(app), "one\nthree\nfour");
    await app.key("Ctrl+Shift+K");
    assert.equal(await text(app), "one\nfour");
    await app.key("Alt+Up");
    assert.equal(await text(app), "four\none");
    await app.key("Alt+Down");
    assert.equal(await text(app), "one\nfour");
    await app.key("Shift+Alt+Down");
    assert.equal(await text(app), "one\nfour\nfour");
  });
});

test("default keys: select next occurrence moved to Ctrl+Shift+D, Ctrl+J joins lines", async () => {
  await session({ text: "foo bar\nfoo baz\nfoo\n" }, async (app) => {
    await app.key("Ctrl+Shift+D");
    assert.match(await status(app), /3 selected/);
    await app.key("Ctrl+Shift+D");
    assert.match(await status(app), /6 selected in 2/);
    await app.key("Escape");
    await app.key("Ctrl+Home");
    await app.key("Ctrl+J");
    assert.equal(await text(app), "foo bar foo baz\nfoo");
  });
});

test("default keys: Ctrl+/ toggles a comment, other owner defaults keep working", async () => {
  await session({ name: "a.js", text: "let a = 1;\nlet b = 2;\n" }, async (app) => {
    await app.waitFor("!!document.querySelector('.cm-line [class*=tok-]')");
    await app.key("Ctrl+/");
    assert.equal(await text(app), "// let a = 1;\nlet b = 2;");
    await app.key("Ctrl+/");
    assert.equal(await text(app), "let a = 1;\nlet b = 2;");
    // Ctrl+T and Ctrl+N open tabs, Alt+Left goes back to the file.
    await app.key("Ctrl+T");
    await app.key("Ctrl+N");
    assert.equal((await app.state()).tabs.length, 3);
    await app.key("Alt+Left");
    await app.key("Alt+Left");
    assert.equal((await app.state()).active, "a.js");
    // The command palette also opens with IntelliJ's and Eclipse's keys (key() waits for its input).
    for (const combo of ["Ctrl+Shift+A", "Ctrl+3"]) {
      await app.key(combo);
      await app.key("Escape");
      await app.waitFor("!document.querySelector('.picker')");
    }
  });
});

test("the Notepad++ preset", async () => {
  await session({ settings: { keymap: "notepad++" }, text: "one\ntwo\nthree\n" }, async (app) => {
    await app.key("Ctrl+D");
    assert.equal(await text(app), "one\none\ntwo\nthree");
    await app.key("Ctrl+Shift+L");
    assert.equal(await text(app), "one\ntwo\nthree");
    await app.key("Ctrl+Home");
    await app.key("Ctrl+Shift+Down");
    assert.equal(await text(app), "two\none\nthree");
    // Alt+Down is not "move line" there: the key is free.
    await app.key("Alt+Down");
    assert.equal(await text(app), "two\none\nthree");
    await app.key("Ctrl+Shift+Up");
    assert.equal(await text(app), "one\ntwo\nthree");
    // Ctrl+U / Ctrl+Shift+U change case, Ctrl+L cuts the line.
    await app.key("Shift+Down");
    await app.key("Ctrl+Shift+U");
    assert.equal(await text(app), "ONE\ntwo\nthree");
    await app.key("Ctrl+Z");
    await app.key("Ctrl+Home");
    await app.key("Ctrl+L");
    assert.equal(await text(app), "two\nthree");
  });
});

test("the VS Code preset, with chords", async () => {
  await session({ port: 9384, settings: { keymap: "vscode" }, name: "a.js", text: "one\ntwo\nthree\n" }, async (app) => {
    await app.waitFor("!!document.querySelector('.cm-line [class*=tok-]')");
    // Ctrl+D selects the next occurrence, Ctrl+Shift+K deletes the line.
    await app.key("Ctrl+D");
    assert.match(await status(app), /3 selected/);
    await app.key("Ctrl+Home");
    await app.key("Ctrl+Shift+K");
    assert.equal(await text(app), "two\nthree");

    // The first key of a chord only waits: nothing else happens, and the status bar says what is expected.
    await app.key("Ctrl+K");
    assert.equal(await hint(app), "Ctrl+K pressed, waiting for the second key…");
    assert.equal(await text(app), "two\nthree");
    await app.key("Ctrl+C");
    assert.equal(await hint(app), null);
    assert.equal(await text(app), "// two\nthree");
    await app.key("Ctrl+K");
    await app.key("Ctrl+U");
    assert.equal(await text(app), "two\nthree");

    // Escape cancels the chord, and the second key then means what it normally means.
    await app.key("Ctrl+K");
    await app.key("Escape");
    assert.equal(await hint(app), null);
    await app.key("Ctrl+C");
    assert.equal(await text(app), "two\nthree");

    // A chord that does not exist is swallowed with a message, nothing is typed.
    await app.key("Ctrl+K");
    await app.key("Q");
    assert.equal(await hint(app), "Ctrl+K Q is not a command.");
    assert.equal(await text(app), "two\nthree");
    await sleep(1700);
    assert.equal(await hint(app), null);
  });
});

test("a chord times out", async () => {
  await session({ port: 9385, settings: { keymap: "vscode" }, name: "a.js", text: "one\n" }, async (app) => {
    await app.waitFor("!!document.querySelector('.cm-line [class*=tok-]')");
    await app.key("Ctrl+K");
    assert.ok(await hint(app));
    await sleep(2400);
    assert.equal(await hint(app), null);
    // Ctrl+C alone is copy again, not "comment".
    await app.key("Ctrl+C");
    assert.equal(await text(app), "one");
  });
});

test("keybindings.json: rebinds, chords, and unbinding frees the key", async () => {
  await session(
    {
      text: "one\ntwo\nthree\n",
      bindings: {
        "edit.deleteLine": null,
        "editor.moveLineDown": null,
        "editor.duplicateLine": "Ctrl+Alt+J",
        "editor.toUpperCase": ["Ctrl+B Ctrl+U"],
      },
    },
    async (app) => {
      // Ctrl+D and Ctrl+Shift+K no longer delete a line, and CodeMirror's own keymap does not either.
      await app.key("Ctrl+D");
      await app.key("Ctrl+Shift+K");
      assert.equal(await text(app), "one\ntwo\nthree");
      // Alt+Down no longer moves the line (CodeMirror must not keep its own binding).
      await app.key("Alt+Down");
      assert.equal(await text(app), "one\ntwo\nthree");
      // The old key of a rebound command is free too, the new one works.
      await app.key("Shift+Alt+Down");
      assert.equal(await text(app), "one\ntwo\nthree");
      await app.key("Ctrl+Alt+J");
      assert.equal(await text(app), "one\none\ntwo\nthree");
      // Other commands keep their keys.
      await app.key("Down");
      await app.key("Alt+Up");
      assert.equal(await text(app), "one\ntwo\none\nthree");
      // A chord of the user's own.
      await app.key("Shift+End");
      await app.key("Ctrl+B");
      await app.key("Ctrl+U");
      assert.equal(await text(app), "one\nTWO\none\nthree");
    },
  );
});

test("an old keybindings.json that lists every default does not pin them under a preset", async () => {
  await session(
    { port: 9386, settings: { keymap: "vscode" }, text: "foo\nfoo\n", bindings: { "edit.deleteLine": ["Ctrl+D", "Ctrl+Shift+K"] } },
    async (app) => {
      await app.key("Ctrl+D");
      assert.equal(await text(app), "foo\nfoo");
      assert.match(await status(app), /3 selected/);
      await app.key("Ctrl+Shift+K");
      assert.equal(await text(app), "foo");
    },
  );
});

test("the shortcut editor writes keybindings.json and applies the key at once", async () => {
  await session({ text: "one\ntwo\nthree\n" }, async (app, data) => {
    // Set a new shortcut for "Duplicate line (below)".
    await palette(app, "Change keyboard shortcut");
    await choose(app, "Change the keyboard shortcut of…", "Duplicate line (below)");
    await choose(app, "Duplicate line (below)", "Set shortcut");
    await app.waitFor("document.querySelector('.capture .keys')");
    await app.key("Ctrl+Alt+J");
    assert.equal(await app.eval("document.querySelector('.capture .keys').textContent.trim()"), "Ctrl+Alt+J");
    await app.key("Enter");
    await app.waitFor("!document.querySelector('.capture')");
    await app.waitFor("document.querySelector('.notice span')?.textContent.includes('now runs')");
    assert.deepEqual(keybindings(data), { "editor.duplicateLine": "Ctrl+Alt+J" });
    // The old key is gone, the new one works without a restart.
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Shift+Alt+Down");
    assert.equal(await text(app), "one\ntwo\nthree");
    await app.key("Ctrl+Alt+J");
    assert.equal(await text(app), "one\none\ntwo\nthree");
  });
});

test("the shortcut editor warns about conflicts and replaces on request", async () => {
  await session({ port: 9384, text: "one\ntwo\nthree\n" }, async (app, data) => {
    await palette(app, "Change keyboard shortcut");
    await choose(app, "Change the keyboard shortcut of…", "Duplicate line (below)");
    await choose(app, "Duplicate line (below)", "Set shortcut");
    await app.waitFor("document.querySelector('.capture .keys')");
    await app.key("Ctrl+D");
    await app.key("Enter");
    await app.waitFor("document.querySelector('.dialog .message')");
    assert.equal((await app.state()).dialog, "Ctrl+D is already used by “Delete line”.");
    await app.key("Enter"); // Replace
    await app.waitFor("document.querySelector('.notice span')?.textContent.includes('now runs')");
    // Delete line keeps its other key, and the replaced one now duplicates.
    assert.deepEqual(keybindings(data), { "editor.duplicateLine": "Ctrl+D", "edit.deleteLine": "Ctrl+Shift+K" });
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Ctrl+D");
    assert.equal(await text(app), "one\none\ntwo\nthree");
    await app.key("Ctrl+Shift+K");
    assert.equal(await text(app), "one\ntwo\nthree");

    // Cancelling the warning changes nothing.
    await palette(app, "Change keyboard shortcut");
    await choose(app, "Change the keyboard shortcut of…", "Join lines");
    await choose(app, "Join lines", "Set shortcut");
    await app.waitFor("document.querySelector('.capture .keys')");
    await app.key("Ctrl+D");
    await app.key("Enter");
    await app.waitFor("document.querySelector('.dialog .message')");
    await app.key("Escape");
    await sleep(200);
    assert.deepEqual(keybindings(data), { "editor.duplicateLine": "Ctrl+D", "edit.deleteLine": "Ctrl+Shift+K" });
  });
});

test("the shortcut editor takes chords, removes and resets shortcuts", async () => {
  await session({ port: 9385, text: "one\ntwo\nthree\n" }, async (app, data) => {
    // A chord: Ctrl+K Ctrl+L for "Transform to upper case".
    await palette(app, "Change keyboard shortcut");
    await choose(app, "Change the keyboard shortcut of…", "Transform to upper case");
    await choose(app, "Transform to upper case", "Set shortcut");
    await app.waitFor("document.querySelector('.capture .keys')");
    await app.key("Ctrl+K");
    await app.key("Ctrl+L");
    assert.equal(await app.eval("document.querySelector('.capture .keys').textContent.trim()"), "Ctrl+K Ctrl+L");
    await app.key("Enter");
    await app.waitFor("document.querySelector('.notice span')?.textContent.includes('now runs')");
    assert.deepEqual(keybindings(data), { "editor.toUpperCase": "Ctrl+K Ctrl+L" });
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Shift+End");
    await app.key("Ctrl+K");
    assert.equal(await hint(app), "Ctrl+K pressed, waiting for the second key…");
    await app.key("Ctrl+L");
    assert.equal(await text(app), "ONE\ntwo\nthree");

    // Remove a shortcut: the key is free.
    await palette(app, "Change keyboard shortcut");
    await choose(app, "Change the keyboard shortcut of…", "Move line down");
    await choose(app, "Move line down", "Remove shortcut");
    await app.waitFor("document.querySelector('.notice span')?.textContent.includes('Removed')");
    assert.deepEqual(keybindings(data), { "editor.toUpperCase": "Ctrl+K Ctrl+L", "editor.moveLineDown": null });
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Alt+Down");
    assert.equal(await text(app), "ONE\ntwo\nthree");

    await palette(app, "Change keyboard shortcut");
    await choose(app, "Change the keyboard shortcut of…", "Move line down");
    await choose(app, "Move line down", "Set shortcut");
    await app.waitFor("document.querySelector('.capture .keys')");
    // A plain letter is refused: it would stop you typing.
    await app.key("Q");
    assert.match(await app.eval("document.querySelector('.capture .hint').textContent"), /Plain keys are for typing/);
    await app.key("Escape");
    await app.waitFor("!document.querySelector('.capture')");

    // Reset to default.
    await palette(app, "Change keyboard shortcut");
    await choose(app, "Change the keyboard shortcut of…", "Move line down");
    await choose(app, "Move line down", "Reset to default");
    await app.waitFor("document.querySelector('.notice span')?.textContent.includes('default shortcut again')");
    assert.deepEqual(keybindings(data), { "editor.toUpperCase": "Ctrl+K Ctrl+L" });
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Alt+Down");
    assert.equal(await text(app), "two\nONE\nthree");
  });
});

test("the preset picker writes settings.json and switches at once", async () => {
  await session({ port: 9386, text: "one\ntwo\n" }, async (app, data) => {
    await palette(app, "keyboard shortcut preset");
    await choose(app, "Select the keyboard shortcut preset", "Notepad++");
    await app.waitFor("document.querySelector('.notice span')?.textContent.includes('Notepad++ preset')");
    assert.deepEqual(JSON.parse(readFileSync(join(data, "settings.json"), "utf8")), { keymap: "notepad++" });
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Ctrl+D");
    assert.equal(await text(app), "one\none\ntwo");
  });
});
