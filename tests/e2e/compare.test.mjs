// Compare tabs: two files with known differences, change markers, F7 navigation, the ignore options,
// the external-change banner. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-compare");
after(() => removeProfile(profile));

const A = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", ""].join("\n");
// Line 2 differs in case, line 4 in indentation, line 8 and the added last line really differ.
const B = ["alpha", "BRAVO", "charlie", "  delta", "echo", "foxtrot", "golf", "hotel-x", "india", "juliet", "kilo", ""].join("\n");

const status = (app) => app.eval("document.querySelector('footer')?.innerText ?? ''");
const changeCount = async (app) => {
  const m = /(\d+) changes?/.exec(await status(app));
  return m ? Number(m[1]) : 0;
};
/** The text of the line that holds the cursor in the compare editor that has the focus. */
const cursorLine = (app) =>
  app.eval("getSelection().anchorNode?.parentElement?.closest('.cm-line')?.textContent ?? null");
/** Answers the "Compare with…" picker, which opens right after the command palette closes. */
async function pickTab(app) {
  await app.waitFor("document.querySelector('input[placeholder^=\"Compare \"]')");
  await app.type("b.txt");
  await app.key("Enter");
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("compares two tabs, jumps between changes and ignores whitespace and case", async () => {
  const a = writeFixture(profile, "a.txt", A);
  const b = writeFixture(profile, "b.txt", B);
  const app = await launch({ port: 9371, profile, files: [b, a] });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'a.txt'");

    await app.key("Ctrl+Shift+P");
    await app.type("compare with…");
    await app.key("Enter");
    await pickTab(app);

    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'a.txt ↔ b.txt'");
    await app.waitFor("document.querySelectorAll('.cm-mergeView .cm-changedLine').length > 0");
    await app.screenshot(process.env.COMPARE_SHOT ?? join(profile, "compare.png"));
    const sides = await app.eval(`({
      editors: document.querySelectorAll('.cm-mergeView .cm-editor').length,
      left: document.querySelectorAll('.cm-merge-a .cm-changedLine').length,
      right: document.querySelectorAll('.cm-merge-b .cm-changedLine').length,
    })`);
    assert.equal(sides.editors, 2);
    assert.ok(sides.left > 0 && sides.right > 0, JSON.stringify(sides));
    assert.equal(await changeCount(app), 4);
    assert.match(await status(app), /F7/);

    // The view opens on the first change; F7 and Shift+F7 move between the changes and wrap around.
    await app.waitFor("getSelection().anchorNode?.parentElement?.closest('.cm-line')?.textContent === 'BRAVO'");
    await app.key("F7");
    assert.equal(await cursorLine(app), "  delta");
    await app.key("F7");
    assert.equal(await cursorLine(app), "hotel-x");
    await app.key("Shift+F7");
    assert.equal(await cursorLine(app), "  delta");
    await app.key("Shift+F7");
    await app.key("Shift+F7");
    assert.equal(await cursorLine(app), "kilo", "wraps to the last change");

    // Ignoring whitespace drops the indentation change, ignoring case the case change as well.
    await app.click(".toolbar label:nth-of-type(1) input");
    await app.waitFor("/3 changes/.test(document.querySelector('footer').innerText)");
    await app.click(".toolbar label:nth-of-type(2) input");
    await app.waitFor("/2 changes/.test(document.querySelector('footer').innerText)");
    await app.click(".toolbar label:nth-of-type(1) input");
    await app.waitFor("/3 changes/.test(document.querySelector('footer').innerText)");

    // The inline (unified) view shows the same changes in one editor.
    await app.click(".toolbar label:nth-of-type(1) input");
    await app.click(".toolbar label:nth-of-type(3) input");
    await app.waitFor("document.querySelectorAll('.compare .cm-editor').length === 1");
    await app.waitFor("document.querySelectorAll('.cm-deletedChunk').length > 0");
    await app.key("F7");
    assert.ok(await cursorLine(app));

    // The compare tab sits right after the tab it was started from.
    assert.deepEqual((await app.state()).tabs, ["b.txt", "a.txt", "a.txt ↔ b.txt"]);
  } finally {
    await app.kill();
  }
});

test("compares the editor with the file on disk when it changed outside", async () => {
  const file = writeFixture(profile, "c.txt", "one\ntwo\nthree\n");
  const app = await launch({ port: 9372, profile: tempProfile("kladde-compare2"), files: [file] });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'c.txt'");
    await app.key("Ctrl+End");
    await app.type("four\n");
    await app.waitFor("document.querySelector('.tab.dirty')");
    writeFileSync(file, "one\n2\nthree\n");
    await app.waitFor("document.querySelector('.banner')", 15000);
    assert.match(await app.eval("document.querySelector('.banner').innerText"), /changed by another program/);
    await app.eval("[...document.querySelectorAll('.banner button')].find((b) => b.textContent === 'Compare').click()");
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'c.txt (on disk) ↔ c.txt'");
    await app.waitFor("document.querySelectorAll('.cm-mergeView .cm-changedLine').length > 0");
    assert.ok((await changeCount(app)) >= 1);
    // The tab stays marked as unsaved and the banner returns with its tab.
    assert.deepEqual((await app.state()).dirty, ["c.txt"]);
    await app.eval("document.querySelector('.tab:not(.active)').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))");
    await app.waitFor("document.querySelector('.banner')");
  } finally {
    await app.kill();
  }
});

test("compare tabs are not restored after a restart", async () => {
  const dir = tempProfile("kladde-compare3");
  const a = writeFixture(dir, "a.txt", A);
  const b = writeFixture(dir, "b.txt", B);
  let app = await launch({ port: 9373, profile: dir, files: [b, a] });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'a.txt'");
    await app.key("Ctrl+Shift+P");
    await app.type("compare with…");
    await app.key("Enter");
    await pickTab(app);
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'a.txt ↔ b.txt'");
    await wait(1500);
    await app.close();
    app = await launch({ port: 9373, profile: dir });
    await app.waitFor("document.querySelectorAll('.tab').length >= 2");
    assert.deepEqual((await app.state()).tabs.sort(), ["a.txt", "b.txt"]);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
});
