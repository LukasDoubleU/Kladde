// Smoke test: opens a file, edits it in a new tab, uses a shortcut. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-smoke");
after(() => removeProfile(profile));

test("opens files and creates tabs", async () => {
  const file = writeFixture(profile, "hello.md", "# Hello\n\nWorld\n");
  const app = await launch({ port: 9340, profile, files: [file] });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'hello.md'");
    let state = await app.state();
    assert.deepEqual(state.tabs, ["hello.md"]);
    assert.match(state.text, /# Hello/);

    await app.key("Ctrl+T");
    await app.type("scratch");
    state = await app.state();
    assert.equal(state.active, "new 1");
    assert.deepEqual(state.dirty, ["new 1"]);

    // Ctrl+D deletes the current line.
    await app.key("Enter");
    await app.type("second line");
    await app.key("Ctrl+D");
    state = await app.state();
    assert.equal(state.text.trim(), "scratch");
  } finally {
    await app.kill();
  }
});
