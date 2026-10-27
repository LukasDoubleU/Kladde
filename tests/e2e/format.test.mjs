// Format document / selection (Shift+Alt+F): the formatter follows the tab's language. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-format");
after(() => removeProfile(profile));

/** Opens one file, runs `body(app)`, and always kills the app. */
async function withFile(port, name, content, body) {
  const file = writeFixture(profile, name, content);
  const app = await launch({ port, profile: tempProfile("kladde-format-run"), files: [file] });
  try {
    await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(name)}`);
    // Wait for the language, which the formatter is chosen by, to be detected.
    await app.waitFor("document.querySelector('.statusbar, footer')?.textContent?.length > 0");
    await body(app);
  } finally {
    await app.kill();
  }
}

const text = (app) => app.eval("document.querySelector('.cm-content').innerText.replace(/\u00a0/g, ' ')");

test("formats CSS with one undoable change", async () => {
  await withFile(9343, "a.css", "a{color:red;margin:0}\nb{padding:1px}\n", async (app) => {
    await app.key("Shift+Alt+F");
    await app.waitFor("document.querySelector('.cm-content').innerText.includes('color: red;')", 10000);
    assert.equal((await text(app)).trimEnd(), "a {\n    color: red;\n    margin: 0;\n}\nb {\n    padding: 1px;\n}");
    await app.key("Ctrl+Z");
    assert.match(await text(app), /^a\{color:red;margin:0\}/);
  });
});

test("formats XML and leaves text content alone", async () => {
  const xml = '<?xml version="1.0"?><root><!-- c --><item id="1"><name>A  b</name></item><empty/></root>\n';
  await withFile(9363, "a.xml", xml, async (app) => {
    await app.key("Shift+Alt+F");
    await app.waitFor("document.querySelector('.cm-content').innerText.includes('<!-- c -->')");
    await app.waitFor("document.querySelectorAll('.cm-line').length > 3");
    assert.equal(
      (await text(app)).trimEnd(),
      '<?xml version="1.0"?>\n<root>\n    <!-- c -->\n    <item id="1">\n        <name>A  b</name>\n    </item>\n    <empty/>\n</root>',
    );
  });
});

test("formats only the selected lines", async () => {
  await withFile(9364, "a.js", "let a  =  1\nlet b={x:1,y:2}\nlet c  =  3\n", async (app) => {
    await app.key("Ctrl+Home");
    await app.key("Down");
    await app.key("Shift+Down");
    await app.key("Shift+Alt+F");
    await app.waitFor("document.querySelector('.cm-content').innerText.includes('let b = { x: 1, y: 2 };')", 10000);
    assert.equal((await text(app)).trimEnd(), "let a  =  1\nlet b = { x: 1, y: 2 };\nlet c  =  3");
  });
});

test("reports errors and unsupported languages", async () => {
  await withFile(9365, "a.json", '{"a": 1,}\n', async (app) => {
    await app.key("Shift+Alt+F");
    await app.waitFor("document.querySelector('.notice span')");
    assert.match((await app.state()).notice, /^Cannot format JSON: /);
    assert.equal((await text(app)).trimEnd(), '{"a": 1,}');
    // A new untitled tab is plain text.
    await app.key("Ctrl+T");
    await app.key("Shift+Alt+F");
    await app.waitFor("document.querySelector('.notice span')?.textContent.startsWith('No formatter')");
    assert.match((await app.state()).notice, /^No formatter for plain text\. Formatting works for JSON, .*YAML\.$/);
  });
});
