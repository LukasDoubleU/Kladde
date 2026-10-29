// The settings page (Ctrl+Alt+S): opening, search, changing settings (written to settings.json and applied at
// once), reset, edits of settings.json, Save all on its new key. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
// Set KLADDE_SHOTS=<folder> to also save screenshots of the page.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-settings");
const data = join(profile, "data");
after(() => removeProfile(profile));

const SHOTS = process.env.KLADDE_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const json = (o) => JSON.stringify(o);
const settingsFile = () => JSON.parse(readFileSync(join(data, "settings.json"), "utf8"));
const activeTab = (name) => `document.querySelector('.tab.active .title')?.textContent === ${json(name)}`;

const a = writeFixture(join(profile, "files"), "a.txt", "alpha\n");
const b = writeFixture(join(profile, "files"), "b.txt", "beta\n");

// Entries Kladde does not know must survive every change the page makes.
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "settings.json"), json({ tabSize: 2, somethingFromTheFuture: { keep: true } }));

let app;
before(async () => {
  app = await launch({ port: 9352, profile, files: [a, b] });
});

/** The row of a setting on the page. */
const row = (name) => `document.querySelector('.page [data-setting=${name}]')`;
const rows = () => app.eval(`[...document.querySelectorAll('.page [data-setting]')].map((r) => r.dataset.setting)`);
const searchFor = async (text) => {
  await app.eval(`(() => { const s = document.querySelector('.page .search'); s.focus(); s.select(); return true; })()`);
  await app.type(text);
  await app.waitFor(`document.querySelector('.page .search').value === ${json(text)}`);
};
const showSettings = async () => {
  await app.key("Ctrl+Alt+S");
  await app.waitFor(`${activeTab("Settings")} && document.activeElement?.matches('.page .search')`);
};
const setChoice = (name, value) =>
  app.eval(`(() => { const el = ${row(name)}.querySelector('select'); el.value = ${json(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

test("Ctrl+Alt+S opens the page with the focus in the search box; it is one tab", async () => {
  await app.waitFor(activeTab("b.txt"));
  await showSettings();
  const state = await app.state();
  assert.deepEqual(state.tabs, ["a.txt", "b.txt", "Settings"]);
  assert.equal(await app.eval("document.querySelector('.editor').classList.contains('hidden')"), true, "the editor is not shown behind the page");
  // Every setting is on the page, grouped, with a label and a description.
  const all = await rows();
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.length >= 25, `only ${all.length} settings`);
  assert.deepEqual(
    await app.eval(`[...document.querySelectorAll('.page section h2')].map((h) => h.textContent)`),
    ["Editor", "Appearance", "Markdown preview", "Large files", "Keyboard", "Spelling and grammar", "Updates", "Windows integration"],
  );
  assert.equal(await app.eval(`[...document.querySelectorAll('.page .row')].every((r) => r.querySelector('label').textContent && r.querySelector('.description').textContent.length > 10)`), true);
  // The values come from settings.json, and only they are marked as different from the default.
  assert.equal(await app.eval(`${row("tabSize")}.querySelector('input').value`), "2");
  assert.deepEqual(await app.eval(`[...document.querySelectorAll('.page .row.changed')].map((r) => r.dataset.setting)`), ["tabSize"]);
  // A second press finds the same tab.
  await app.key("Ctrl+Alt+S");
  assert.equal((await app.state()).tabs.length, 3);

  if (SHOTS) await app.screenshot(join(SHOTS, "settings-page.png"), { width: 1100, height: 760 });
});

test("search filters by label, description and setting name; Escape clears it, then leaves the page", async () => {
  await searchFor("ligatures");
  await app.waitFor(`document.querySelectorAll('.page [data-setting]').length === 1`);
  assert.deepEqual(await rows(), ["fontLigatures"]);
  await app.key("Escape");
  await app.waitFor(`document.querySelector('.page .search').value === ''`);
  assert.equal((await app.state()).active, "Settings", "the first Escape only clears the search");
  assert.ok((await rows()).length >= 25);

  // The description ("GitHub"), the name (camelCase) and the label (two words, any order).
  await searchFor("github");
  await app.waitFor(`document.querySelectorAll('.page [data-setting]').length === 1`);
  assert.deepEqual(await rows(), ["checkForUpdates"]);
  await searchFor("largefilethreshold");
  await app.waitFor(`document.querySelector('.page [data-setting=largeFileThresholdMB]') && document.querySelectorAll('.page [data-setting]').length === 1`);
  await searchFor("size tab");
  await app.waitFor(`document.querySelector('.page [data-setting=tabSize]') && document.querySelectorAll('.page [data-setting]').length === 1`);
  // Sections without a match disappear.
  assert.deepEqual(await app.eval(`[...document.querySelectorAll('.page section h2')].map((h) => h.textContent)`), ["Editor"]);

  await searchFor("no such setting");
  await app.waitFor(`document.querySelector('.page .empty')`);
  assert.deepEqual(await rows(), []);
  if (SHOTS) {
    await searchFor("font");
    await app.waitFor(`document.querySelector('.page [data-setting=fontSize]') && !document.querySelector('.page [data-setting=tabSize]')`);
    await app.screenshot(join(SHOTS, "settings-page-search.png"), { width: 1100, height: 760 });
  }

  await app.key("Escape"); // clears
  await app.key("Escape"); // leaves: back to the tab it was opened from
  await app.waitFor(activeTab("b.txt"));
  await showSettings();
  assert.equal(await app.eval("document.querySelector('.page .search').value"), "", "the search was cleared");
});

// A number or text box commits when it loses the focus (or on Enter, which sends no character event here, so the
// tests leave with Tab).
test("a switch, a number and a choice are written to settings.json and applied at once", async () => {
  const wrapped = () => app.eval("document.querySelector('.cm-content').classList.contains('cm-lineWrapping')");
  assert.equal(await wrapped(), false);
  await app.click(`.page [data-setting=wordWrap] .switch`);
  await app.waitFor(`${row("wordWrap")}.querySelector('.switch').getAttribute('aria-checked') === 'true'`);
  assert.deepEqual(settingsFile(), { tabSize: 2, somethingFromTheFuture: { keep: true }, wordWrap: true });
  assert.equal(await wrapped(), true, "word wrap applies without a restart");
  assert.equal(await app.eval(`${row("wordWrap")}.classList.contains('changed')`), true);

  await app.eval(`(() => { const i = ${row("fontSize")}.querySelector('input'); i.focus(); i.select(); return true; })()`);
  await app.type("20");
  await app.key("Tab");
  await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size') === '20px'`);
  assert.equal(settingsFile().fontSize, 20);

  // Out of range: clamped to the allowed range, and the box shows what was stored.
  await app.eval(`(() => { const i = ${row("fontSize")}.querySelector('input'); i.focus(); i.select(); return true; })()`);
  await app.type("500");
  await app.key("Tab");
  await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size') === '72px'`);
  assert.equal(settingsFile().fontSize, 72);
  assert.equal(await app.eval(`${row("fontSize")}.querySelector('input').value`), "72");
  // Not a number: nothing changes.
  await app.eval(`(() => { const i = ${row("fontSize")}.querySelector('input'); i.focus(); i.select(); return true; })()`);
  await app.key("Backspace");
  await app.key("Tab");
  await app.waitFor(`${row("fontSize")}.querySelector('input').value === '72'`);
  assert.equal(settingsFile().fontSize, 72);

  await setChoice("accent", "mauve");
  await app.waitFor(`document.documentElement.dataset.accent === 'mauve'`);
  assert.equal(settingsFile().accent, "mauve");
  await setChoice("theme", "latte");
  await app.waitFor(`document.documentElement.dataset.theme === 'latte'`);
  assert.equal(settingsFile().theme, "latte");

  // Text: the other entries stay.
  await app.eval(`(() => { const i = ${row("pasteImageFolder")}.querySelector('input'); i.focus(); i.select(); return true; })()`);
  await app.type("img");
  await app.key("Tab");
  await app.waitFor(`${row("pasteImageFolder")}.classList.contains('changed')`);
  const file = settingsFile();
  assert.equal(file.pasteImageFolder, "img");
  assert.deepEqual(file.somethingFromTheFuture, { keep: true });
  assert.equal(file.tabSize, 2);
});

test("reset to default removes the entry and restores the default", async () => {
  // Only changed settings can be reset.
  assert.equal(await app.eval(`${row("lineNumbers")}.querySelector('.reset').disabled`), true);
  await app.click(`.page [data-setting=accent] .reset`);
  await app.waitFor(`document.documentElement.dataset.accent === 'rosewater'`);
  assert.equal("accent" in settingsFile(), false);
  assert.equal(await app.eval(`${row("accent")}.classList.contains('changed')`), false);
  await app.click(`.page [data-setting=theme] .reset`);
  await app.waitFor(`document.documentElement.dataset.theme === 'mocha'`);
  await app.click(`.page [data-setting=wordWrap] .reset`);
  await app.waitFor(`!document.querySelector('.cm-content').classList.contains('cm-lineWrapping')`);
  await app.click(`.page [data-setting=fontSize] .reset`);
  await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size') === '14px'`);
  await app.click(`.page [data-setting=pasteImageFolder] .reset`);
  await app.waitFor(`${row("pasteImageFolder")}.querySelector('input').value === 'assets'`);
  // Setting a value back to the default by hand drops the entry as well.
  await setChoice("accent", "teal");
  await app.waitFor(`document.documentElement.dataset.accent === 'teal'`);
  await setChoice("accent", "rosewater");
  await app.waitFor(`document.documentElement.dataset.accent === 'rosewater'`);
  await app.waitFor(`${row("accent")}.querySelector('.reset').disabled`);
  assert.deepEqual(settingsFile(), { tabSize: 2, somethingFromTheFuture: { keep: true } });
});

test("the links open settings.json and theme.css, and the shortcut editor", async () => {
  await app.eval(`[...document.querySelectorAll('.page header button')].find((b) => b.textContent.includes('settings.json')).click()`);
  await app.waitFor(activeTab("settings.json"));
  await app.key("Ctrl+Alt+S");
  await app.waitFor(activeTab("Settings"));
  await app.eval(`[...document.querySelectorAll('.page [data-group=appearance] .links button')].find((b) => b.textContent.includes('theme.css')).click()`);
  await app.waitFor(activeTab("theme.css"));
  await app.key("Ctrl+Alt+S");
  await app.waitFor(activeTab("Settings"));
  await app.eval(`[...document.querySelectorAll('.page [data-group=keys] .links button')].find((b) => b.textContent.includes('Change keyboard shortcut')).click()`);
  await app.waitFor(`document.querySelector('.picker input')?.placeholder.startsWith('Change the keyboard shortcut')`);
  await app.key("Escape");
  await app.waitFor(`!document.querySelector('.picker')`);
});

test("settings.json edited and saved in a tab shows on the page; invalid values do not break it", async () => {
  await app.waitFor(activeTab("Settings"));
  await app.key("Ctrl+Alt+S");
  // The settings.json tab from above (opened by the link), now edited like any file.
  await app.eval(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.title').textContent === 'settings.json').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
  await app.waitFor(activeTab("settings.json"));
  await app.eval("document.querySelector('.cm-content').focus(), true");
  await app.key("Ctrl+A");
  await app.type(json({ tabSize: 7, fontSize: "huge", accent: "plaid", markdownPreview: "only", wordWrap: "yes" }));
  await app.key("Ctrl+S");
  await app.waitFor(`document.querySelector('.notice')?.textContent.includes('Unknown accent')`);

  await showSettings();
  assert.equal(await app.eval(`${row("tabSize")}.querySelector('input').value`), "7");
  assert.equal(await app.eval(`${row("markdownPreview")}.querySelector('select').value`), "only");
  // Values of the wrong type or unknown names fall back to the default, and the page says why.
  assert.equal(await app.eval(`${row("fontSize")}.querySelector('input').value`), "14");
  assert.equal(await app.eval(`${row("accent")}.querySelector('select').value`), "rosewater");
  assert.equal(await app.eval(`${row("wordWrap")}.querySelector('.switch').getAttribute('aria-checked')`), "false");
  assert.match(await app.eval(`document.querySelector('.page .problem')?.textContent ?? ''`), /accent "plaid"/);
  // The page still works: a change is written next to the entries it does not touch.
  await app.click(`.page [data-setting=lineNumbers] .switch`);
  await app.waitFor(`${row("lineNumbers")}.classList.contains('changed')`);
  assert.deepEqual(settingsFile(), { tabSize: 7, fontSize: "huge", accent: "plaid", markdownPreview: "only", wordWrap: "yes", lineNumbers: false });
  await app.click(`.page [data-setting=lineNumbers] .reset`);
  await app.waitFor(`!${row("lineNumbers")}.classList.contains('changed')`);
});

test("a settings.json that is not valid JSON is reported and never overwritten", async () => {
  const text = '{ "tabSize": 7,, }';
  writeFileSync(join(data, "settings.json"), text);
  await app.eval(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.title').textContent === 'settings.json').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
  await app.waitFor(activeTab("settings.json"));
  await app.waitFor(`document.querySelector('.cm-content').innerText.includes(',,')`, 8000);
  await app.key("Ctrl+S");
  await app.waitFor(`document.querySelector('.notice')?.textContent.includes('not valid JSON')`);
  await showSettings();
  assert.match(await app.eval(`document.querySelector('.page .problem')?.textContent ?? ''`), /not valid JSON/);
  await app.click(`.page [data-setting=wordWrap] .switch`);
  await app.waitFor(`document.querySelector('.notice')?.textContent.includes('not valid JSON')`);
  assert.equal(readFileSync(join(data, "settings.json"), "utf8"), text);
  writeFileSync(join(data, "settings.json"), json({}));
});

test("Ctrl+Alt+Shift+S saves all; Ctrl+Alt+S no longer does", async () => {
  const dirty = () => app.eval(`[...document.querySelectorAll('.tab.dirty .title')].map((t) => t.textContent)`);
  for (const name of ["a.txt", "b.txt"]) {
    await app.eval(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.title').textContent === ${json(name)}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    await app.waitFor(activeTab(name));
    await app.eval("document.querySelector('.cm-content').focus(), true");
    await app.key("Ctrl+End");
    await app.type(" edited");
  }
  await app.waitFor(`document.querySelectorAll('.tab.dirty').length === 2`);
  await app.key("Ctrl+Alt+S");
  await app.waitFor(activeTab("Settings"));
  assert.equal((await dirty()).length, 2, "Ctrl+Alt+S opens the page and saves nothing");
  assert.equal(readFileSync(a, "utf8"), "alpha\n");

  await app.key("Ctrl+Alt+Shift+S");
  await app.waitFor(`document.querySelectorAll('.tab.dirty').length === 0`);
  assert.match(readFileSync(a, "utf8"), /edited/);
  assert.match(readFileSync(b, "utf8"), /edited/);
});

test("the settings tab is not part of the session: a restart restores the files, not the page", async () => {
  await app.waitFor(activeTab("Settings"));
  await app.close();
  const again = await launch({ port: 9353, profile, files: [] });
  try {
    const state = await again.state();
    assert.deepEqual(state.tabs, ["a.txt", "b.txt", "settings.json", "theme.css"]);
    assert.equal(state.notice, null);
    // And the page opens again, with the settings of the file.
    await again.eval("document.querySelector('.cm-content').focus(), true");
    await again.key("Ctrl+Alt+S");
    await again.waitFor(`${activeTab("Settings")} && document.querySelectorAll('.page [data-setting]').length >= 25`);
  } finally {
    await again.kill();
  }
});
