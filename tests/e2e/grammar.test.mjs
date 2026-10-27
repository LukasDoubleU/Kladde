// Grammar and spell checking with LanguageTool. A small fake LanguageTool server on localhost answers
// with canned matches, so nothing here touches the network. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const profiles = [];
after(() => Promise.all(profiles.map(removeProfile)));

const lt = (offset, length, id, issueType, category, replacements, message) => ({
  offset,
  length,
  message,
  replacements: replacements.map((value) => ({ value })),
  rule: { id, issueType, category: { id: category } },
});

/** A LanguageTool stand-in: flags "eror" (spelling) and "This are" (grammar) in the text it is given. */
async function fakeServer() {
  const requests = [];
  const state = { mode: "ok" };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const annotation = JSON.parse(form.get("data")).annotation;
      // What LanguageTool would check: markup does not count as text but keeps its length.
      const readable = annotation.map((i) => i.text ?? " ".repeat(i.markup.length)).join("");
      requests.push({
        method: req.method,
        url: req.url,
        language: form.get("language"),
        variants: form.get("preferredVariants"),
        sent: annotation.filter((i) => i.text !== undefined).map((i) => i.text).join(""),
        length: annotation.map((i) => i.text ?? i.markup).join("").length,
      });
      if (state.mode === "500") return void res.writeHead(500).end("boom");
      if (state.mode === "429") return void res.writeHead(429, { "Retry-After": "30" }).end("slow down");
      const matches = [];
      for (const m of readable.matchAll(/\beror\b/g)) {
        matches.push(lt(m.index, 4, "MORFOLOGIK_RULE_EN_US", "misspelling", "TYPOS", ["error"], "Possible spelling mistake found."));
      }
      for (const m of readable.matchAll(/This (are)\b/g)) {
        matches.push(lt(m.index + 5, 3, "PLURAL_VERB_AFTER_THIS", "grammar", "GRAMMAR", ["is"], "The verb 'are' is plural."));
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ matches }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

/** A fresh profile with settings.json in place. */
function profileWith(settings, name = "kladde-lt") {
  const profile = tempProfile(name);
  profiles.push(profile);
  mkdirSync(join(profile, "data"), { recursive: true });
  writeFileSync(join(profile, "data", "settings.json"), JSON.stringify(settings));
  return profile;
}

async function runCommand(app, text) {
  await app.key("Ctrl+Shift+P");
  await app.type(text);
  await app.key("Enter");
}

async function open(port, profile, file) {
  const app = await launch({ port, profile, files: [file] });
  await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(file.split(/[\\/]/).pop())}`);
  return app;
}

const statusText = (app) => app.eval("[...document.querySelectorAll('footer button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('Grammar')) ?? null");
const body = (app) => app.eval("document.querySelector('.cm-content').innerText.replace(/\\u00a0/g, ' ')");

const DOC = "This are a test with `eror` in code and a eror here.\n\n```\neror\n```\n\nSecond paragraph is fine.\n";

test("underlines findings, shows the message and applies a quick fix", async () => {
  const server = await fakeServer();
  const profile = profileWith({ languageToolServer: server.url });
  const app = await open(9387, profile, writeFixture(profile, "doc.md", DOC));
  try {
    // Off until asked for: nothing is sent.
    await wait(1800);
    assert.equal(server.requests.length, 0);
    assert.equal(await statusText(app), null);

    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 1 && document.querySelectorAll('.cm-lt-grammar').length === 1", 10000);
    await app.waitFor("[...document.querySelectorAll('footer button')].some((b) => b.textContent.includes('2 issues'))");

    // One POST to /v2/check; code and fences are not sent; the language is detected, with preferred variants.
    assert.equal(server.requests.length, 1);
    const [request] = server.requests;
    assert.equal(`${request.method} ${request.url}`, "POST /v2/check");
    assert.equal(request.language, "auto");
    assert.equal(request.variants, "en-US,de-DE");
    assert.ok(request.sent.includes("a test with ") && !request.sent.includes("`eror`") && !request.sent.includes("```"), request.sent);
    // The code block is not part of any paragraph, so it is not sent at all.
    assert.equal(request.length, `${DOC.split("\n\n")[0]}\n\nSecond paragraph is fine.`.length);

    const marks = await app.eval(`[...document.querySelectorAll('.cm-lintRange')].map((e) => ({
      text: e.textContent, kind: e.className.match(/cm-lt-\\w+/)[0], style: getComputedStyle(e).textDecorationStyle,
      color: getComputedStyle(e).textDecorationColor, image: getComputedStyle(e).backgroundImage,
    }))`);
    assert.deepEqual(marks.map((m) => [m.text, m.kind]), [["are", "cm-lt-grammar"], ["eror", "cm-lt-spelling"]]);
    assert.ok(marks.every((m) => m.style === "wavy" && m.image === "none"), JSON.stringify(marks));
    assert.notEqual(marks[0].color, marks[1].color);

    // Hover shows the message with the replacements; choosing one is an undoable edit.
    const rect = await app.eval(`(() => { const r = document.querySelector('.cm-lt-spelling').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await app.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await app.waitFor("document.querySelector('.cm-tooltip-lint .cm-diagnosticAction')", 5000);
    const tip = await app.eval(`({
      text: document.querySelector('.cm-tooltip-lint .cm-diagnosticText').textContent,
      actions: [...document.querySelectorAll('.cm-tooltip-lint .cm-diagnosticAction')].map((b) => b.textContent),
    })`);
    assert.equal(tip.text, "Possible spelling mistake found.");
    assert.deepEqual(tip.actions, ["error", "Ignore word"]);
    await app.screenshot(join(profile, "tooltip.png"));
    await app.eval("document.querySelector('.cm-tooltip-lint .cm-diagnosticAction').click()");
    assert.match(await body(app), /and a error here\./);
    assert.match(await body(app), /`eror`/);
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 0");
    await app.key("Ctrl+Z");
    assert.match(await body(app), /and a eror here\./);

    // Typing re-checks only the changed paragraph.
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 1", 10000);
    const before = server.requests.length;
    await app.key("Ctrl+End");
    await app.key("Enter");
    await app.type("Another eror.");
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 2", 10000);
    assert.equal(server.requests.length, before + 1);
    assert.equal(server.requests.at(-1).sent, "Another eror.");
  } finally {
    await app.kill();
    server.close();
  }
});

test("ignoring a word removes its underline", async () => {
  const server = await fakeServer();
  const profile = profileWith({ languageToolServer: server.url, grammarCheck: true });
  const app = await open(9388, profile, writeFixture(profile, "ignore.txt", "One eror and another eror.\n"));
  try {
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 2", 10000);
    const rect = await app.eval(`(() => { const r = document.querySelector('.cm-lt-spelling').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await app.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await app.waitFor("document.querySelector('.cm-tooltip-lint .cm-diagnosticAction')", 5000);
    await app.eval("[...document.querySelectorAll('.cm-tooltip-lint .cm-diagnosticAction')].find((b) => b.textContent === 'Ignore word').click()");
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 0");
    assert.equal(await statusText(app), "Grammar: no issues");
  } finally {
    await app.kill();
    server.close();
  }
});

test("only Markdown and plain text by default, any file with languageToolAllFiles", async () => {
  const server = await fakeServer();
  const profile = profileWith({ languageToolServer: server.url, grammarCheck: true });
  const app = await open(9389, profile, writeFixture(profile, "code.js", "// This are a eror\nlet a = 1;\n"));
  try {
    await wait(2500);
    assert.equal(server.requests.length, 0);
    assert.equal(await statusText(app), null);
    // Changing the setting in settings.json applies without a restart.
    await runCommand(app, "open settings");
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'settings.json'");
    await app.key("Ctrl+Home");
    await app.key("Right");
    await app.type('"languageToolAllFiles": true,');
    await app.key("Ctrl+S");
    await app.waitFor("document.querySelector('.notice span')?.textContent === 'Settings applied.'");
    await app.key("Ctrl+W");
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'code.js'");
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 1", 10000);
    assert.ok(server.requests.some((r) => r.sent.includes("This are a eror")));
  } finally {
    await app.kill();
    server.close();
  }
});

test("without a server the command explains what to configure", async () => {
  const profile = profileWith({});
  const app = await open(9387, profile, writeFixture(profile, "a.txt", "This are a eror.\n"));
  try {
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    const { dialog } = await app.state();
    assert.equal(dialog, "Grammar checking needs a LanguageTool server.");
    const detail = await app.eval("document.querySelector('.dialog .detail').textContent");
    assert.match(detail, /languageToolServer/);
    assert.match(detail, /localhost:8081/);
    assert.match(detail, /third party/);
    await app.key("Escape");
    assert.equal(await statusText(app), null);
  } finally {
    await app.kill();
  }
});

test("the public server needs a one-time confirmation before any text is sent", async () => {
  const profile = profileWith({ languageToolServer: "https://api.languagetool.org" });
  const app = await open(9388, profile, writeFixture(profile, "a.txt", "This are a eror.\n"));
  try {
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    assert.equal((await app.state()).dialog, "Send your text to the public LanguageTool server?");
    assert.match(await app.eval("document.querySelector('.dialog .detail').textContent"), /third party/);
    // Declining leaves checking off.
    await app.key("Escape");
    await wait(2500);
    assert.equal(await statusText(app), null);
    assert.equal(await app.eval("document.querySelectorAll('.cm-lintRange').length"), 0);
  } finally {
    await app.kill();
  }
});

test("a failing server is reported once and then left alone; rate limits stay quiet", async () => {
  const server = await fakeServer();
  server.state.mode = "500";
  const profile = profileWith({ languageToolServer: server.url, grammarCheck: true });
  const app = await open(9389, profile, writeFixture(profile, "a.txt", "This are a eror.\n"));
  try {
    await app.waitFor("document.querySelector('.notice span')?.textContent.startsWith('Grammar checking failed')", 10000);
    assert.match((await app.state()).notice, /status 500/);
    assert.equal(await statusText(app), "Grammar: unavailable");
    // Edits during the backoff send nothing more and raise no further notice.
    await app.key("Ctrl+End");
    for (let i = 0; i < 3; i++) {
      await app.type(" more");
      await wait(1400);
    }
    assert.equal(server.requests.length, 1);
    assert.equal(await statusText(app), "Grammar: unavailable");
  } finally {
    await app.kill();
    server.close();
  }

  const limited = await fakeServer();
  limited.state.mode = "429";
  const profile2 = profileWith({ languageToolServer: limited.url, grammarCheck: true });
  const app2 = await open(9387, profile2, writeFixture(profile2, "a.txt", "This are a eror.\n"));
  try {
    await app2.waitFor("[...document.querySelectorAll('footer button')].some((b) => b.textContent === 'Grammar: waiting')", 10000);
    await wait(1500);
    assert.equal((await app2.state()).notice, null);
    assert.equal(limited.requests.length, 1);
  } finally {
    await app2.kill();
    limited.close();
  }
});

test("long documents are checked around the visible part, within the request size", async () => {
  const server = await fakeServer();
  const profile = profileWith({ languageToolServer: server.url, grammarCheck: true, wordWrap: true });
  const paragraphs = Array.from({ length: 900 }, (_, i) => `Paragraph ${i + 1} has a eror in it.`);
  const app = await open(9388, profile, writeFixture(profile, "long.txt", paragraphs.join("\n\n") + "\n"));
  try {
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length > 5", 10000);
    await wait(500);
    const first = server.requests[0];
    assert.ok(first.sent.includes("Paragraph 1 has"));
    assert.ok(!first.sent.includes("Paragraph 900 "), "the end of the document is not part of the first request");
    assert.ok(server.requests.every((r) => r.length <= 15000), JSON.stringify(server.requests.map((r) => r.length)));
    const before = server.requests.length;

    await app.eval("(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = s.scrollHeight; })()");
    await wait(2500);
    assert.ok(server.requests.length > before, "scrolling asks for the paragraphs now in view");
    assert.ok(server.requests.at(-1).sent.includes("Paragraph 900 has"));
    await app.waitFor("[...document.querySelectorAll('.cm-lt-spelling')].some((e) => e.closest('.cm-line').textContent.includes('Paragraph 900'))", 10000);
  } finally {
    await app.kill();
    server.close();
  }
});

test("the language can be set per file and the choice is remembered with the on/off state", async () => {
  const server = await fakeServer();
  const profile = profileWith({ languageToolServer: server.url });
  const file = writeFixture(profile, "lang.md", "---\nlang: de\n---\nThis are a eror.\n");
  let app = await open(9389, profile, file);
  try {
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 1", 10000);
    // The front matter picks the language, bare codes get a variant.
    assert.equal(server.requests.at(-1).language, "de-DE");
    assert.equal(server.requests.at(-1).variants, null);

    await runCommand(app, "grammar checking language");
    await app.type("fr");
    await app.key("Enter");
    const count = server.requests.length;
    await wait(2500);
    assert.ok(server.requests.length > count, "a new language means a new check");
    assert.equal(server.requests.at(-1).language, "fr");
    await app.close();

    // After a restart the tab still checks, in the language chosen for it, without being asked again.
    app = await launch({ port: 9389, profile, files: [] });
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'lang.md'", 10000);
    await app.waitFor("document.querySelectorAll('.cm-lt-spelling').length === 1", 10000);
    assert.equal(server.requests.at(-1).language, "fr");
  } finally {
    await app.kill();
    server.close();
  }
});
