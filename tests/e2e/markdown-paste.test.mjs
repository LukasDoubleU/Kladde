// Markdown pasted into an empty untitled tab: the tab switches to Markdown (with a way back), nothing else is
// ever switched, and Save As suggests the extension of the language. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
//
// The paste is a synthetic ClipboardEvent with a DataTransfer, dispatched into CodeMirror's content element:
// CodeMirror handles it like Ctrl+V (`input.paste`), and the system clipboard, which is the user's, is never read
// or written.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile } from "./kladde.mjs";

const profile = tempProfile("kladde-mdpaste");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const README = `# Notes on the release

A short summary of what changed.

## Changes

- Faster startup
- **Markdown** preview

\`\`\`sh
npm ci
\`\`\`
`;

const PYTHON = `# Utilities for parsing

import os

# Paths
BASE = os.getcwd()

def parse(path, **kwargs):
    # Read the file
    with open(path) as f:
        return f.read()
`;

/** A settings.json in a fresh profile folder. */
function freshProfile(settings) {
  const dir = tempProfile("kladde-mdpaste-run");
  mkdirSync(join(dir, "data"), { recursive: true });
  if (settings) writeFileSync(join(dir, "data", "settings.json"), JSON.stringify(settings));
  return dir;
}

/** Pastes like Ctrl+V does, without the clipboard; returns whether CodeMirror took the event. */
const paste = (app, text) =>
  app.eval(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(text)});
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(event);
    return event.defaultPrevented;
  })()`);

const look = (app) =>
  app.eval(`({
    language: document.querySelector('footer button[title="Select language"]')?.textContent.trim() ?? null,
    preview: !!document.querySelector('.preview-pane'),
    previewButton: [...document.querySelectorAll('footer button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('Preview')) ?? null,
    notice: document.querySelector('.notice span')?.textContent ?? null,
    action: document.querySelector('.notice .action')?.textContent ?? null,
    editorFocused: !!document.activeElement?.closest('.cm-content'),
    text: document.querySelector('.cm-content')?.innerText ?? '',
    title: document.querySelector('.tab.active .title')?.textContent ?? null,
    dirty: !!document.querySelector('.tab.active.dirty'),
  })`);

/** A new tab with the focus in the editor. */
async function newTab(app) {
  const before = (await app.state()).tabs.length;
  // Keys go to the page: it needs the focus first (the first key after a start is lost otherwise).
  await app.eval("document.querySelector('.cm-content').focus(), true");
  await app.key("Ctrl+N");
  await app.waitFor(`document.querySelectorAll('.tab .title').length === ${before + 1}`);
  await app.eval("document.querySelector('.cm-content').focus(), true");
}

/** Runs a command from the command palette by (part of) its name. */
async function palette(app, name) {
  await app.key("Ctrl+Shift+P");
  await app.waitFor("!!document.querySelector('.picker input')");
  await app.type(name);
  await app.waitFor("!!document.querySelector('.picker [role=option]')");
  await app.key("Enter");
}

/** Picks a language the way the user does (status bar / palette: "Change language mode…"). */
async function pickLanguage(app, label) {
  await palette(app, "Change language mode");
  await app.waitFor(`document.querySelector('.picker input')?.placeholder === "Select language mode"`);
  await app.type(label);
  await app.waitFor(`document.querySelector('.picker [role=option]')?.textContent.includes(${JSON.stringify(label)})`);
  await app.key("Enter");
  await app.waitFor("!document.querySelector('.picker')");
  await app.waitFor(`document.querySelector('footer button[title="Select language"]')?.textContent.trim() === ${JSON.stringify(label)}`);
  await app.eval("document.querySelector('.cm-content').focus(), true");
}

async function expectSwitched(app) {
  await app.waitFor(`document.querySelector('footer button[title="Select language"]')?.textContent.trim() === 'Markdown'`);
  await app.waitFor("!!document.querySelector('.notice .action')");
}

async function expectPlain(app, why) {
  await sleep(400);
  const s = await look(app);
  assert.equal(s.language, "Plain Text", why);
  assert.equal(s.preview, false, why);
  assert.equal(s.notice, null, why);
}

test("the first paste of Markdown into an empty untitled tab switches to Markdown, with a notice and a way back", async () => {
  const app = await launch({ port: 9452, profile: freshProfile() });
  try {
    await newTab(app);
    assert.equal((await look(app)).language, "Plain Text");
    assert.equal(await paste(app, README), true, "CodeMirror handled the paste event");
    await expectSwitched(app);

    const s = await look(app);
    assert.equal(s.language, "Markdown");
    assert.equal(s.preview, true, "the preview opens as markdownPreview says (default: side by side)");
    assert.equal(s.previewButton, "Preview: side by side");
    assert.equal(s.notice, "Pasted text looks like Markdown: switched to Markdown.");
    assert.equal(s.action, "Keep Plain Text");
    assert.ok(s.editorFocused, "the focus stays in the editor");
    assert.match(s.text, /Notes on the release/);
    await app.waitFor("document.querySelector('.preview-pane h1')?.textContent === 'Notes on the release'");
    await app.waitFor("!!document.querySelector('.cm-content .tok-heading')", 10000);

    // Undo removes the pasted text in one step; the language stays.
    await app.key("Ctrl+Z");
    await app.waitFor("document.querySelector('.cm-content').innerText.trim() === ''");
    const undone = await look(app);
    assert.equal(undone.language, "Markdown");
    assert.ok(undone.editorFocused);
    // ... and redo brings it back whole.
    await app.key("Ctrl+Y");
    await app.waitFor("document.querySelector('.cm-content').innerText.includes('npm ci')");
  } finally {
    await app.kill();
  }
});

test("Keep Plain Text takes it back, closes the preview and is final for this tab", async () => {
  const app = await launch({ port: 9453, profile: freshProfile() });
  try {
    await newTab(app);
    await paste(app, README);
    await expectSwitched(app);
    await app.click(".notice .action");
    await app.waitFor("document.querySelector('footer button[title=\"Select language\"]')?.textContent.trim() === 'Plain Text'");
    await app.waitFor("!document.querySelector('.notice')");
    await app.waitFor("!!document.activeElement?.closest('.cm-content')");
    const s = await look(app);
    assert.equal(s.preview, false);
    assert.match(s.text, /Notes on the release/, "the text stays");
    assert.equal(s.dirty, true);

    // The user decided: emptying the tab and pasting Markdown again does not switch it.
    await app.key("Ctrl+A");
    await app.key("Delete");
    await paste(app, README);
    await expectPlain(app, "a tab the user kept as Plain Text is never switched");

    // A control in the same app: a fresh tab does switch, so the quiet above is not a broken detector.
    await newTab(app);
    await paste(app, README);
    await expectSwitched(app);
  } finally {
    await app.kill();
  }
});

test("nothing else is switched: other text, later pastes, a chosen language, files", async () => {
  const dir = freshProfile();
  const file = join(dir, "notes.txt");
  writeFileSync(file, "plain notes\n");
  const app = await launch({ port: 9454, profile: dir, files: [file] });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'notes.txt'");

    // A file on disk, emptied and pasted into.
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Ctrl+A");
    await app.key("Delete");
    await paste(app, README);
    await expectPlain(app, "a file is never switched");

    // Text that is not Markdown stays Plain Text.
    await newTab(app);
    assert.equal(await paste(app, PYTHON), true);
    await expectPlain(app, "a Python script is not Markdown");
    // ... and so does a later paste of Markdown: the tab has text now.
    await paste(app, README);
    await expectPlain(app, "a tab with text is never switched");

    // The user picked Plain Text first.
    await newTab(app);
    await pickLanguage(app, "Plain Text");
    await paste(app, README);
    await expectPlain(app, "a tab whose language the user picked is never switched");

    // Typed text, then Markdown pasted.
    await newTab(app);
    await app.type("hello ");
    await paste(app, README);
    await expectPlain(app, "typed text counts as text");

    // The user picked another language.
    await newTab(app);
    await pickLanguage(app, "Python");
    await paste(app, README);
    await sleep(400);
    assert.equal((await look(app)).language, "Python");
    assert.equal((await look(app)).notice, null);

    // Control: an empty untitled tab does switch.
    await newTab(app);
    await paste(app, README);
    await expectSwitched(app);
  } finally {
    await app.kill();
  }
});

test("a tab the user decided about stays that way after a restart", async () => {
  const dir = freshProfile();
  const first = await launch({ port: 9455, profile: dir });
  try {
    await newTab(first);
    await pickLanguage(first, "Plain Text");
    await first.type("draft");
    await first.waitFor("!!document.querySelector('.tab.active.dirty')");
    await first.close();
  } catch (e) {
    await first.kill();
    throw e;
  }
  const second = await launch({ port: 9456, profile: dir });
  try {
    await second.waitFor("document.querySelector('.cm-content').innerText.includes('draft')");
    await second.eval("document.querySelector('.cm-content').focus(), true");
    await second.key("Ctrl+A");
    await second.key("Delete");
    await paste(second, README);
    await expectPlain(second, "the choice was saved with the session");
    await newTab(second);
    await paste(second, README);
    await expectSwitched(second);
  } finally {
    await second.kill();
  }
});

test("with markdownPreview off the tab switches without a preview", async () => {
  const app = await launch({ port: 9457, profile: freshProfile({ markdownPreview: "off" }) });
  try {
    await newTab(app);
    await paste(app, README);
    await expectSwitched(app);
    const s = await look(app);
    assert.equal(s.language, "Markdown");
    assert.equal(s.preview, false);
    assert.equal(s.previewButton, "Preview: off");
  } finally {
    await app.kill();
  }
});

test("Save As suggests the extension of the language, and a Markdown tab stays Markdown with its preview", async () => {
  const dir = freshProfile();
  const app = await launch({ port: 9458, profile: dir });
  try {
    // The native file dialog cannot be driven. Tauri sends the call of it as a fetch to its IPC protocol, and the
    // page's fetch is replaced here (the IPC object itself is frozen): the dialog's request is answered with what the
    // test chooses and recorded, every other command goes through. The path answered is inside the isolated profile.
    await app.eval(`(() => {
      const original = window.fetch.bind(window);
      window.__ipc = [];
      window.__dialogs = [];
      window.__answer = null;
      window.fetch = (input, init) => {
        const url = decodeURIComponent(String(input?.url ?? input));
        window.__ipc.push(url);
        if (url.endsWith("plugin:dialog|save")) {
          window.__dialogs.push(JSON.parse(init.body).options.defaultPath ?? null);
          return Promise.resolve(new Response(JSON.stringify(window.__answer), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } }));
        }
        return original(input, init);
      };
      return true;
    })()`);
    // Before any key is pressed: a harmless command must show up in the wrapper, or a real dialog could open on the desktop.
    await app.eval(`window.__TAURI_INTERNALS__.invoke("stat_file", { path: ${JSON.stringify(dir)} })`);
    assert.equal(await app.eval('window.__ipc.some((u) => u.endsWith("stat_file"))'), true, "the IPC calls pass through the page's fetch");
    const proposed = async (answer = null) => {
      const seen = await app.eval("window.__dialogs.length");
      await app.eval(`window.__answer = ${JSON.stringify(answer)}, true`);
      await app.key("Ctrl+Shift+S");
      await app.waitFor(`window.__dialogs.length === ${seen + 1}`);
      return app.eval("window.__dialogs[window.__dialogs.length - 1]");
    };

    // Plain Text: .txt, as before.
    await newTab(app);
    await app.type("just text");
    assert.match(await proposed(), /^new \d+\.txt$/);

    // A language the user picked.
    await newTab(app);
    await pickLanguage(app, "Python");
    await app.type("print(1)");
    assert.match(await proposed(), /^new \d+\.py$/);

    // Markdown, detected from a paste, with the preview shown only.
    await newTab(app);
    await paste(app, README);
    await expectSwitched(app);
    await app.key("Ctrl+Shift+V");
    await app.waitFor("[...document.querySelectorAll('footer button')].some((b) => b.textContent.trim() === 'Preview: only')");
    const target = join(dir, "release-notes.md");
    const defaultPath = await proposed(target);
    assert.match(defaultPath, /^new \d+\.md$/);

    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'release-notes.md'");
    await app.waitFor("!document.querySelector('.tab.active.dirty')");
    assert.equal(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), README);
    const s = await look(app);
    assert.equal(s.language, "Markdown", "detected again from the path: unchanged");
    assert.equal(s.previewButton, "Preview: only", "the preview state is intact");
    assert.equal(s.preview, true);
  } finally {
    await app.kill();
  }
});
