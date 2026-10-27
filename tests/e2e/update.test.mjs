// Update check: banner, portable or installed decision, once-a-day limit, setting, command.
//
// A local server plays GitHub: it serves a fake latest.json (KLADDE_UPDATE_URL, honored only with the
// isolated profile launch() sets) and records every request. The installer is never downloaded or run:
// the test fails if the installer URL is requested, and the app itself refuses to install from an
// isolated profile.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEBUG_EXE, launch, removeProfile, tempProfile } from "./kladde.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profiles = [];
const newProfile = () => {
  const p = tempProfile("kladde-update");
  profiles.push(p);
  return p;
};

let server;
let base;
let requests;
/** What the server answers for latest.json: a version, "none" (204) or "error" (500). */
let answer;

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url !== "/latest.json") {
      res.writeHead(404).end();
    } else if (answer === "none") {
      res.writeHead(204).end();
    } else if (answer === "error") {
      res.writeHead(500).end("boom");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          version: answer,
          notes: "Fake release",
          pub_date: "2030-01-01T00:00:00Z",
          platforms: {
            "windows-x86_64": { signature: "ZmFrZQ==", url: `${base}/Kladde_${answer}_x64-setup.exe` },
          },
        }),
      );
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  for (const p of profiles) await removeProfile(p);
});

const env = () => ({ KLADDE_UPDATE_URL: `${base}/latest.json` });
const manifestRequests = () => requests.filter((r) => r === "/latest.json").length;
const installerRequested = () => requests.some((r) => r.endsWith(".exe"));

const banner = (app) => app.eval("document.querySelector('.update')?.innerText ?? null");
const buttons = (app) => app.eval("[...document.querySelectorAll('.update button')].map((b) => b.textContent.trim())");
const notice = (app) => app.eval("document.querySelector('.notice span')?.textContent ?? null");
const clickButton = (app, text) =>
  app.eval(`(() => {
    const b = [...document.querySelectorAll('.update button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!b) return false;
    b.click();
    return true;
  })()`);

async function runCommand(app, query) {
  await app.key("Ctrl+Shift+P");
  await app.waitFor("document.querySelector('.picker input')");
  await app.type(query);
  await sleep(100);
  await app.key("Enter");
}

test("portable exe: banner offers the download, one check per day", async () => {
  requests = [];
  answer = "9.9.9";
  const profile = newProfile();
  let app = await launch({ port: 9394, profile, env: env() });
  try {
    // The check waits a few seconds after start so it never delays opening files.
    assert.equal(await banner(app), null);
    assert.equal(manifestRequests(), 0);
    await app.waitFor("document.querySelector('.update')", 15000);
    assert.match(await banner(app), /Kladde 9\.9\.9 is available/);
    assert.deepEqual(await buttons(app), ["Download", "Release notes", "Later"]);
    assert.equal(manifestRequests(), 1);
    assert.ok(existsSync(join(profile, "data", "last-update-check")));

    await clickButton(app, "Later");
    assert.equal(await banner(app), null);
    await app.close();

    // Second start within a day: no request, no banner.
    app = await launch({ port: 9394, profile, env: env() });
    await sleep(8000);
    assert.equal(manifestRequests(), 1);
    assert.equal(await banner(app), null);

    // The command asks anyway.
    await runCommand(app, "Check for updates");
    await app.waitFor("document.querySelector('.update')", 5000);
    assert.equal(manifestRequests(), 2);
    assert.equal(installerRequested(), false);
  } finally {
    await app.kill();
  }
});

test("installed copy offers Update now, but a test profile never installs", async () => {
  requests = [];
  answer = "9.9.9";
  const profile = newProfile();
  // The NSIS installer puts uninstall.exe next to the exe; a copy with a stand-in counts as installed.
  const dir = join(profile, "installed");
  mkdirSync(dir, { recursive: true });
  copyFileSync(DEBUG_EXE, join(dir, "kladde.exe"));
  writeFileSync(join(dir, "uninstall.exe"), "");
  const app = await launch({ port: 9395, profile, exe: join(dir, "kladde.exe"), env: env() });
  try {
    await app.waitFor("document.querySelector('.update')", 15000);
    assert.deepEqual(await buttons(app), ["Update now", "Release notes", "Later"]);

    assert.ok(await clickButton(app, "Update now"));
    await app.waitFor("document.querySelector('.notice.error')", 5000);
    assert.match(await notice(app), /Could not install the update: Updates are not installed in an isolated profile/);
    // The banner stays so the user can try again, and nothing was downloaded.
    assert.deepEqual(await buttons(app), ["Update now", "Release notes", "Later"]);
    assert.equal(installerRequested(), false);
  } finally {
    await app.kill();
  }
});

test("an isolated profile without a test endpoint does not check (never the real GitHub)", async () => {
  const app = await launch({ port: 9349, profile: newProfile() });
  try {
    await sleep(7000);
    assert.equal(await banner(app), null);
    await runCommand(app, "Check for updates");
    await app.waitFor("document.querySelector('.notice.error')", 5000);
    assert.match(await notice(app), /KLADDE_UPDATE_URL/);
  } finally {
    await app.kill();
  }
});

test("setting off: no automatic check; the command still works", async () => {
  requests = [];
  answer = "none";
  const profile = newProfile();
  mkdirSync(join(profile, "data"), { recursive: true });
  writeFileSync(join(profile, "data", "settings.json"), JSON.stringify({ checkForUpdates: false }));
  const app = await launch({ port: 9396, profile, env: env() });
  try {
    await sleep(8000);
    assert.equal(manifestRequests(), 0);

    await runCommand(app, "Check for updates");
    await app.waitFor("document.querySelector('.notice')", 5000);
    assert.match(await notice(app), /You’re up to date/);
    assert.equal(manifestRequests(), 1);
    assert.equal(await banner(app), null);

    answer = "error";
    await runCommand(app, "Check for updates");
    await app.waitFor("document.querySelector('.notice.error')", 5000);
    assert.match(await notice(app), /Could not check for updates/);

    answer = "9.9.9";
    await runCommand(app, "Check for updates");
    await app.waitFor("document.querySelector('.update')", 5000);
    assert.equal(installerRequested(), false);
  } finally {
    await app.kill();
  }
});
