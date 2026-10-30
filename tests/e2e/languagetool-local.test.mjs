// The local LanguageTool that Kladde downloads, starts and stops itself. Nothing here touches the real
// downloads or the network: a local HTTP server serves two small zips that look like the LanguageTool and Java
// archives, and the "server" Kladde starts is a Node script (fake-languagetool.mjs) that speaks the LanguageTool
// API. Both are wired in through the overrides that an isolated profile honors (KLADDE_LT_DOWNLOADS,
// KLADDE_LT_COMMAND, KLADDE_LT_IDLE_SECS). Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { matchesIn, readable } from "./fake-lt.mjs";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";
import { makeZip } from "./zip.mjs";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fake-languagetool.mjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const profiles = [];
const closers = [];

after(async () => {
  for (const close of closers) close();
  // A stand-in server left behind by a failing test must not keep the profile folder locked.
  for (const profile of profiles) for (const pid of startedPids(profile)) if (alive(pid)) process.kill(pid);
  await Promise.all(profiles.map(removeProfile));
});

// ------------------------------------------------------------------ helpers

/** Serves the two archives. `delay` (ms per chunk of `chunk` bytes) slows the download down; `corrupt` damages the LanguageTool one. */
async function downloadServer({ delay = 0, chunk = 16 * 1024 } = {}) {
  const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
  const lt = makeZip([
    ["LanguageTool-6.8/languagetool-server.jar", "stand-in for the server jar"],
    ["LanguageTool-6.8/libs/padding.bin", randomBytes(1_500_000)],
  ]);
  const jre = makeZip([
    ["jdk-21.0.13+9-jre/bin/java.exe", "stand-in for java"],
    ["jdk-21.0.13+9-jre/padding.bin", randomBytes(1_500_000)],
  ]);
  const state = { delay, chunk, corrupt: false, requests: [] };
  const server = createServer((req, res) => {
    state.requests.push(req.url);
    let body = req.url === "/lt.zip" ? lt : jre;
    if (state.corrupt && req.url === "/lt.zip") {
      body = Buffer.from(body);
      body[Math.floor(body.length / 2)] ^= 0xff;
    }
    res.writeHead(200, { "content-type": "application/zip", "content-length": body.length });
    let at = 0;
    const next = () => {
      if (res.destroyed || at >= body.length) return void res.end();
      res.write(body.subarray(at, at + state.chunk));
      at += state.chunk;
      setTimeout(next, state.delay);
    };
    next();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    downloads: JSON.stringify({
      languagetool: { url: `${base}/lt.zip`, sha256: sha(lt), size: lt.length },
      java: { url: `${base}/jre.zip`, sha256: sha(jre), size: jre.length },
    }),
  };
}

/** A server of the user's own, in this process: records what it is asked and flags "eror". */
async function ownServer() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const annotation = JSON.parse(new URLSearchParams(body).get("data")).annotation;
      requests.push(annotation.map((i) => i.text ?? "").join(""));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ matches: matchesIn(readable(annotation)) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function profileWith(settings) {
  const profile = tempProfile("kladde-ltlocal");
  profiles.push(profile);
  mkdirSync(join(profile, "data"), { recursive: true });
  writeFileSync(join(profile, "data", "settings.json"), JSON.stringify(settings));
  return profile;
}

/** The environment of a test instance: the download server, the stand-in for Java and where it reports to. */
const envOf = (profile, dl, extra = {}) => ({
  KLADDE_LT_DOWNLOADS: dl.downloads,
  KLADDE_LT_COMMAND: JSON.stringify([process.execPath, FAKE_SERVER]),
  FAKE_LT_PID_FILE: join(profile, "fake.pid"),
  FAKE_LT_LOG: join(profile, "fake.log"),
  FAKE_LT_STARTUP_MS: "1500",
  ...extra,
});

const log = (profile) => {
  const file = join(profile, "fake.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const starts = (profile) => log(profile).filter((e) => e.event === "start");
const startedPids = (profile) => starts(profile).map((e) => e.pid);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition, what, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!(await condition())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await wait(100);
  }
}

const lastPid = (profile) => startedPids(profile).at(-1);
const dataPath = (profile, ...parts) => join(profile, "data", ...parts);
const ltDir = (profile) => dataPath(profile, "languagetool", "6.8");
const jreDir = (profile) => dataPath(profile, "jre", "21.0.13+9");

async function open(port, profile, dl, file, extra) {
  const app = await launch({ port, profile, files: [file], env: envOf(profile, dl, extra) });
  await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(file.split(/[\\/]/).pop())}`);
  return app;
}

async function runCommand(app, text) {
  await app.key("Ctrl+Shift+P");
  await app.type(text);
  await app.key("Enter");
}

const footer = (app) => app.eval("[...document.querySelectorAll('footer button')].map((b) => b.textContent.trim())");
const grammarStatus = async (app) => (await footer(app)).find((t) => t.startsWith("Grammar")) ?? null;
const notice = (app) => app.eval("document.querySelector('.notice span')?.textContent ?? null");
const spelling = (app) => app.eval("document.querySelectorAll('.cm-lt-spelling').length");
const clickDialog = (app, label) =>
  app.eval(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()`);

async function installViaCommand(app) {
  await runCommand(app, "download local languagetool");
  await app.waitFor("document.querySelector('.notice span')?.textContent === 'LanguageTool is installed.'", 20000);
}

const DOC = "This are a eror.\n";

// ------------------------------------------------------------------ tests

test("offers the download, shows progress, can be cancelled, then installs and checks through the managed server", async () => {
  // Slow enough to see the progress and to cancel: about 4 s per archive.
  const dl = await downloadServer({ delay: 40 });
  const profile = profileWith({});
  const app = await open(9369, profile, dl, writeFixture(profile, "doc.md", DOC));
  try {
    // Nothing at start: nothing downloaded, nothing started, no grammar status.
    await wait(1500);
    assert.deepEqual(dl.state.requests, []);
    assert.equal(starts(profile).length, 0);

    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    assert.equal((await app.state()).dialog, "Grammar checking needs LanguageTool.");
    // Giving up downloads nothing.
    await app.key("Escape");
    await wait(500);
    assert.deepEqual(dl.state.requests, []);
    assert.equal(await grammarStatus(app), null);

    // Download: the status bar shows the progress, a click on it cancels, and nothing is left installed.
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    await clickDialog(app, "Download");
    const progress = async () => (await footer(app)).find((t) => t.startsWith("Downloading LanguageTool"));
    await until(async () => /^Downloading LanguageTool… \d+ %$/.test((await progress()) ?? ""), "the download progress");
    await app.eval("[...document.querySelectorAll('footer button')].find((b) => b.textContent.includes('LanguageTool…')).click()");
    await app.waitFor("document.querySelector('.notice span')?.textContent === 'The download was cancelled. Nothing was installed.'", 15000);
    assert.ok(!existsSync(ltDir(profile)) && !existsSync(jreDir(profile)));
    for (const root of ["languagetool", "jre"]) {
      const left = existsSync(dataPath(profile, root)) ? readdirSync(dataPath(profile, root)) : [];
      assert.deepEqual(left, [], `${root} holds no leftovers`);
    }
    assert.equal(await grammarStatus(app), null);
    assert.ok(!(await footer(app)).some((t) => t.includes("LanguageTool…")));

    // Again, fast this time: installs, switches grammar checking on and starts the server with the first check.
    dl.state.delay = 0;
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    await clickDialog(app, "Download");
    const seen = [];
    await until(async () => {
      seen.push([await grammarStatus(app), await notice(app)]);
      return (await grammarStatus(app)) === "Grammar: 2 issues";
    }, "the findings", 30000);
    // The status bar said that the server is starting, and no error showed up in between.
    assert.ok(seen.some(([status]) => status === "Grammar: starting LanguageTool…"), JSON.stringify(seen));
    assert.ok(seen.every(([, text]) => !/fail|error|could not/i.test(text ?? "")), JSON.stringify(seen));
    assert.equal(await spelling(app), 1);
    assert.ok(existsSync(join(ltDir(profile), "languagetool-server.jar")) && existsSync(join(jreDir(profile), "bin", "java.exe")));

    // One start, on a loopback port Kladde chose, and the text arrived there.
    const [started] = starts(profile);
    assert.equal(starts(profile).length, 1);
    assert.deepEqual(started.args.slice(0, 1), ["--port"]);
    assert.equal(Number(started.args[1]), started.port);
    assert.equal((await fetch(`http://127.0.0.1:${started.port}/v2/languages`)).status, 200);
    assert.ok(log(profile).some((e) => e.event === "check" && e.sent.includes("This are a eror.")));

    // The server dies with Kladde, even when Kladde does not get to say goodbye.
    const pid = started.pid;
    assert.ok(alive(pid));
    await app.kill();
    await until(() => !alive(pid), "the server to end with Kladde", 10000);
  } finally {
    await app.kill();
  }
});

test("stops when idle or when checking is turned off, starts again on demand, and can be removed", async () => {
  const dl = await downloadServer();
  const profile = profileWith({});
  const app = await open(9370, profile, dl, writeFixture(profile, "doc.md", DOC), { KLADDE_LT_IDLE_SECS: "3" });
  try {
    await installViaCommand(app);
    // Installing starts nothing.
    assert.equal(starts(profile).length, 0);

    // The settings page says what is installed.
    await app.key("Ctrl+Alt+S");
    await app.waitFor("document.querySelector('[data-local-languagetool] .status')", 5000);
    const panel = () => app.eval("document.querySelector('[data-local-languagetool]').textContent.replace(/\\s+/g, ' ')");
    assert.match(await panel(), /Installed: LanguageTool 6\.8 with Java 21\.0\.13\+9, \d+ MB on disk\. Not running/);
    await app.key("Escape");
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'doc.md'");

    // On: no dialog any more, the server starts with the first check.
    await runCommand(app, "toggle grammar checking");
    await until(async () => (await spelling(app)) === 1, "the first findings", 30000);
    const first = lastPid(profile);
    assert.equal(starts(profile).length, 1);
    assert.ok(alive(first));

    // Idle: stopped after the (shortened) timeout, without any message.
    await until(() => !alive(first), "the idle stop", 15000);
    assert.notEqual((await grammarStatus(app))?.includes("unavailable"), true);

    // The next edit starts it again, with a new process.
    await app.key("Ctrl+End");
    await app.type(" Another eror.");
    await until(async () => (await spelling(app)) === 2, "the check after the restart", 30000);
    const second = lastPid(profile);
    assert.equal(starts(profile).length, 2);
    assert.notEqual(second, first);
    assert.ok(alive(second));
    assert.equal(await app.eval("document.querySelector('.notice span')?.textContent.startsWith('Grammar checking failed') ?? false"), false);

    // Off: stopped at once.
    await runCommand(app, "toggle grammar checking");
    await until(() => !alive(second), "the server to stop when checking is turned off", 10000);

    // On again with a changed paragraph: a new start.
    await app.type(" Third eror.");
    await runCommand(app, "toggle grammar checking");
    await until(async () => starts(profile).length === 3 && (await spelling(app)) >= 1, "the third start", 30000);
    const third = lastPid(profile);
    assert.ok(alive(third));

    // Removing while it runs: server stopped, folders gone, checking off, the page says so.
    await app.key("Ctrl+Alt+S");
    await app.waitFor("document.querySelector('[data-local-languagetool] button')", 5000);
    assert.match(await panel(), /Running\./);
    await app.eval("[...document.querySelectorAll('[data-local-languagetool] button')].find((b) => b.textContent === 'Remove').click()");
    await app.waitFor("document.querySelector('.dialog .message')?.textContent === 'Remove the local LanguageTool?'", 5000);
    await clickDialog(app, "Remove");
    await app.waitFor("document.querySelector('.notice span')?.textContent === 'The local LanguageTool was removed.'", 10000);
    await until(() => !alive(third), "the server to stop when LanguageTool is removed", 10000);
    assert.ok(!existsSync(dataPath(profile, "languagetool")) && !existsSync(dataPath(profile, "jre")));
    assert.match(await panel(), /Not installed\./);
    assert.equal(await app.eval("[...document.querySelectorAll('[data-local-languagetool] button')].map((b) => b.textContent).join()"), "Download");
    // The dialog took the focus from the page's search box: go back by the tab history instead of Escape.
    await app.key("Alt+Left");
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'doc.md'");
    assert.equal(await grammarStatus(app), null);
  } finally {
    await app.kill();
  }
});

test("a configured server always wins; clearing the setting falls back to the local one", async () => {
  const own = await ownServer();
  const dl = await downloadServer();
  const profile = profileWith({ languageToolServer: own.url });
  const app = await open(9374, profile, dl, writeFixture(profile, "doc.md", DOC));
  try {
    // With the local LanguageTool installed, a toggle still goes to the configured server.
    await installViaCommand(app);
    await runCommand(app, "toggle grammar checking");
    await until(async () => (await spelling(app)) === 1, "the findings of the own server");
    assert.ok(own.requests.some((text) => text.includes("This are a eror.")));
    await wait(2500);
    assert.equal(starts(profile).length, 0, "the managed server was not started");

    // Clear the setting on the settings page: the next check goes to the managed server.
    await app.key("Ctrl+Alt+S");
    await app.waitFor("document.querySelector('[data-setting=\"languageToolServer\"] input')", 5000);
    await app.eval(`(() => {
      const input = document.querySelector('[data-setting="languageToolServer"] input');
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await app.waitFor("!document.querySelector('[data-setting=\"languageToolServer\"]').classList.contains('changed')", 5000);
    await app.key("Escape");
    await until(() => starts(profile).length === 1 && log(profile).some((e) => e.event === "check"), "the managed server to be asked", 30000);
    await until(async () => (await grammarStatus(app)) === "Grammar: 2 issues", "the findings of the managed server");
  } finally {
    await app.kill();
  }
});

test("a download that does not match its checksum is deleted, reported, and the next attempt works", async () => {
  const dl = await downloadServer();
  dl.state.corrupt = true;
  const profile = profileWith({});
  const app = await open(9375, profile, dl, writeFixture(profile, "doc.md", DOC));
  try {
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    await clickDialog(app, "Download");
    await app.waitFor("document.querySelector('.notice span')?.textContent.startsWith('Could not download LanguageTool:')", 20000);
    assert.match(await notice(app), /does not match its published checksum/);
    assert.ok(!existsSync(ltDir(profile)));
    const left = existsSync(dataPath(profile, "languagetool")) ? readdirSync(dataPath(profile, "languagetool")) : [];
    assert.deepEqual(left, [], "the damaged file is gone");
    assert.equal(await grammarStatus(app), null);
    assert.equal(starts(profile).length, 0);
    assert.deepEqual(dl.state.requests, ["/jre.zip", "/lt.zip"]);

    // Same session, good download: the part that was fine (Java) is not fetched again.
    dl.state.corrupt = false;
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    await clickDialog(app, "Download");
    await until(async () => (await spelling(app)) === 1, "the findings after the second try", 30000);
    assert.deepEqual(dl.state.requests, ["/jre.zip", "/lt.zip", "/lt.zip"]);
  } finally {
    await app.kill();
  }
});

test("the public API is offered, but only used after its confirmation", async () => {
  const dl = await downloadServer();
  const profile = profileWith({});
  const app = await open(9377, profile, dl, writeFixture(profile, "doc.md", DOC));
  try {
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.dialog .message')", 5000);
    await clickDialog(app, "Use the public API");
    await app.waitFor("document.querySelector('.dialog .message')?.textContent === 'Send your text to the public LanguageTool server?'", 5000);
    assert.match(await app.eval("document.querySelector('.dialog .detail').textContent"), /third party/);
    // Declining: no setting written, nothing downloaded, checking stays off. (The public API is never called by tests.)
    await app.key("Escape");
    await wait(1500);
    const settingsFile = dataPath(profile, "settings.json");
    assert.ok(!("languageToolServer" in JSON.parse(readFileSync(settingsFile, "utf8"))));
    assert.deepEqual(dl.state.requests, []);
    assert.equal(await grammarStatus(app), null);
  } finally {
    await app.kill();
  }
});

test("a server that fails to start is reported once and the next attempt works", async () => {
  const dl = await downloadServer();
  const profile = profileWith({});
  const failOnce = join(profile, "fail-once");
  writeFileSync(failOnce, "x");
  const app = await open(9378, profile, dl, writeFixture(profile, "doc.md", DOC), { FAKE_LT_FAIL_ONCE: failOnce, FAKE_LT_STARTUP_MS: "0" });
  try {
    await installViaCommand(app);
    await runCommand(app, "toggle grammar checking");
    await app.waitFor("document.querySelector('.notice span')?.textContent.startsWith('Grammar checking failed')", 20000);
    const text = await notice(app);
    assert.match(text, /The local LanguageTool could not be started: it exited \(exit code 1\)/);
    assert.match(text, /could not create the Java Virtual Machine/);
    assert.equal(await grammarStatus(app), "Grammar: unavailable");
    assert.equal(starts(profile).length, 0);

    // Kladde asks again after the pause and the server comes up this time.
    await until(async () => (await spelling(app)) === 1, "the retry to succeed", 40000);
    assert.equal(starts(profile).length, 1);
    assert.equal(await grammarStatus(app), "Grammar: 2 issues");
  } finally {
    await app.kill();
  }
});

test("a server that died while running is started again by the next check", async () => {
  const dl = await downloadServer();
  const profile = profileWith({});
  const app = await open(9379, profile, dl, writeFixture(profile, "doc.md", DOC), { FAKE_LT_STARTUP_MS: "0" });
  try {
    await installViaCommand(app);
    await runCommand(app, "toggle grammar checking");
    await until(async () => (await spelling(app)) === 1, "the first findings");
    const first = lastPid(profile);
    process.kill(first);
    await until(() => !alive(first), "the server to die");
    // The next check starts a new one, quietly: the editor text and the findings are untouched.
    await app.key("Ctrl+End");
    await app.type(" Another eror.");
    await until(async () => (await spelling(app)) === 2, "the check after the crash", 30000);
    assert.equal(starts(profile).length, 2);
    assert.ok(alive(lastPid(profile)) && lastPid(profile) !== first);
    assert.equal(await app.eval("document.querySelector('.notice span')?.textContent.startsWith('Grammar checking failed') ?? false"), false);
    assert.match((await app.state()).text, /This are a eror\.\n Another eror\./);
  } finally {
    await app.kill();
  }
});
