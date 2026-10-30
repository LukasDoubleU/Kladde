// Update check: banner, portable or installed decision, one-hour throttle, periodic check, Later, setting,
// command, and the header of the settings page (version, Check now, result, last check).
//
// A local server plays GitHub: it serves a fake latest.json (KLADDE_UPDATE_URL, honored only with the
// isolated profile launch() sets) and records every request. The installer is never downloaded or run:
// the test fails if the installer URL is requested, and the app itself refuses to install from an
// isolated profile.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { DEBUG_EXE, launch, removeProfile, tempProfile } from "./kladde.mjs";

const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version;
const RELEASES = "https://github.com/LukasDoubleU/Kladde/releases/tag";
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
/** What the server answers for latest.json: a version, "none" (204), "slow" (204 after 1.5 s) or "error" (500). */
let answer;

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url !== "/latest.json") {
      res.writeHead(404).end();
    } else if (answer === "none") {
      res.writeHead(204).end();
    } else if (answer === "slow") {
      setTimeout(() => res.writeHead(204).end(), 1500);
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

test("portable exe: banner offers the download, no second request within the hour", async () => {
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

    // Second start within the hour: no request, no banner.
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

/** Writes the marker of a completed check `ago` seconds in the past (negative: in the future). */
function writeMarker(profile, ago) {
  mkdirSync(join(profile, "data"), { recursive: true });
  writeFileSync(join(profile, "data", "last-update-check"), String(Math.floor(Date.now() / 1000) - ago));
}
const marker = (profile) => Number(readFileSync(join(profile, "data", "last-update-check"), "utf8"));

test("automatic check at every start, skipped only within an hour of the last completed one", async () => {
  requests = [];
  answer = "9.9.9";
  const profile = newProfile();
  writeMarker(profile, 30 * 60);
  let app = await launch({ port: 9359, profile, env: env() });
  try {
    await sleep(8000);
    assert.equal(manifestRequests(), 0, "a check 30 minutes ago throttles the start");
    assert.equal(await banner(app), null);
  } finally {
    await app.kill();
  }

  // Two hours ago (a manual check in the afternoon, the release in the evening): asks again at the start.
  writeMarker(profile, 2 * 60 * 60);
  app = await launch({ port: 9360, profile, env: env() });
  try {
    await app.waitFor("document.querySelector('.update')", 15000);
    assert.equal(manifestRequests(), 1);
    assert.ok(Date.now() / 1000 - marker(profile) < 60, "the marker is renewed");
    await app.kill();

    // A timestamp in the future (clock set back) counts as due.
    requests = [];
    writeMarker(profile, -3 * 60 * 60);
    app = await launch({ port: 9361, profile, env: env() });
    await app.waitFor("document.querySelector('.update')", 15000);
    assert.equal(manifestRequests(), 1);
  } finally {
    await app.kill();
  }
});

test("periodic check: Later hides that version until the next start, a newer one is announced", async () => {
  requests = [];
  answer = "9.9.9";
  const profile = newProfile();
  // The period is 3 s here (6 h otherwise) and the throttle is off; this only works in an isolated profile.
  let app = await launch({ port: 9362, profile, env: { ...env(), KLADDE_UPDATE_PERIOD_SECS: "3" } });
  try {
    await app.waitFor("document.querySelector('.update')", 15000);
    assert.match(await banner(app), /Kladde 9\.9\.9 is available/);
    await clickButton(app, "Later");
    assert.equal(await banner(app), null);

    // At least two more periodic checks ask, and neither brings the dismissed version back.
    const before = manifestRequests();
    await sleep(8000);
    assert.ok(manifestRequests() >= before + 2, `only ${manifestRequests() - before} periodic requests`);
    assert.equal(await banner(app), null);

    answer = "9.9.10";
    await app.waitFor("document.querySelector('.update')", 8000);
    assert.match(await banner(app), /Kladde 9\.9\.10 is available/);
    await app.kill();

    // A new start announces the dismissed version again.
    answer = "9.9.9";
    writeMarker(profile, 2 * 60 * 60);
    app = await launch({ port: 9366, profile, env: env() });
    await app.waitFor("document.querySelector('.update')", 15000);
    assert.match(await banner(app), /Kladde 9\.9\.9 is available/);
  } finally {
    await app.kill();
  }
});

test("periodic check respects the setting", async () => {
  requests = [];
  answer = "9.9.9";
  const profile = newProfile();
  mkdirSync(join(profile, "data"), { recursive: true });
  writeFileSync(join(profile, "data", "settings.json"), JSON.stringify({ checkForUpdates: false }));
  const app = await launch({ port: 9367, profile, env: { ...env(), KLADDE_UPDATE_PERIOD_SECS: "2" } });
  try {
    await sleep(11000);
    assert.equal(manifestRequests(), 0);
    assert.equal(await banner(app), null);
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

    // The settings page offers the same: an installed copy gets Update now there, too.
    await showSettings(app);
    assert.deepEqual(await app.eval(`[...document.querySelectorAll('.page .outcome button')].map((b) => b.textContent.trim())`), ["Update now"]);
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

// The header of the settings page (Ctrl+Alt+S): version, release notes, Check now, result, last check.
const about = (app, selector) => app.eval(`document.querySelector('.page .about ${selector}')?.textContent.trim() ?? null`);
const outcome = (app) => about(app, ".outcome");
const showSettings = async (app) => {
  await app.key("Ctrl+Alt+S");
  await app.waitFor("document.activeElement?.matches('.page .search')");
};
const clickCheckNow = (app) => app.eval("document.querySelector('.page .about .check').click(); true");

test("settings page header: version, release notes, Check now with the result inline, last check", async () => {
  requests = [];
  answer = "slow";
  const profile = newProfile();
  // No automatic check, so only the button asks.
  mkdirSync(join(profile, "data"), { recursive: true });
  writeFileSync(join(profile, "data", "settings.json"), JSON.stringify({ checkForUpdates: false }));
  const app = await launch({ port: 9368, profile, env: env() });
  try {
    await showSettings(app);
    await app.waitFor("document.querySelector('.page .about .version')");
    assert.equal(await about(app, ".version"), `Kladde ${VERSION}`);
    // A real link to this version's release page (not clicked: it would open the browser).
    assert.equal(await app.eval("document.querySelector('.page .about .link').href"), `${RELEASES}/v${VERSION}`);
    assert.equal(await about(app, ".last"), "Last checked: never");
    assert.equal(await outcome(app), null);

    // The result shows inline while the button is disabled, and the notice stays out of the way.
    await clickCheckNow(app);
    await app.waitFor("document.querySelector('.page .about .check').disabled");
    assert.equal(await outcome(app), "Checking…");
    await app.waitFor("document.querySelector('.page .about .outcome')?.textContent.includes('Up to date')");
    assert.equal(await app.eval("document.querySelector('.page .about .check').disabled"), false);
    assert.equal(await notice(app), null);
    assert.equal(manifestRequests(), 1);
    await app.waitFor("/^Last checked: today [0-9]/.test(document.querySelector('.page .about .last').textContent)");
    assert.ok(Date.now() / 1000 - marker(profile) < 60);

    // Searching does not filter the header away.
    await app.eval("document.querySelector('.page .search').focus(); true");
    await app.type("ligatures");
    await app.waitFor("document.querySelectorAll('.page [data-setting]').length === 1");
    assert.equal(await about(app, ".version"), `Kladde ${VERSION}`);

    // A failed check reports the error and does not touch the time of the last check.
    const last = await about(app, ".last");
    answer = "error";
    await clickCheckNow(app);
    await app.waitFor("document.querySelector('.page .about .outcome')?.textContent.includes('Could not check')");
    assert.equal(await about(app, ".last"), last);
    assert.equal(await notice(app), null);

    // An update: announced inline (a portable exe gets Download) and, as before, in the banner.
    answer = "9.9.9";
    await clickCheckNow(app);
    await app.waitFor("document.querySelector('.page .about .outcome')?.textContent.includes('Kladde 9.9.9 is available')");
    assert.deepEqual(await app.eval("[...document.querySelectorAll('.page .about .outcome button')].map((b) => b.textContent.trim())"), ["Download"]);
    assert.equal(await app.eval("document.querySelector('.page .about .outcome .link').href"), `${RELEASES}/v9.9.9`);
    assert.match(await banner(app), /Kladde 9\.9\.9 is available/);
    assert.equal(manifestRequests(), 3);
    assert.equal(installerRequested(), false);

    // Later in the banner takes the announcement from the page too.
    await clickButton(app, "Later");
    await app.waitFor("!document.querySelector('.page .about .outcome')");
  } finally {
    await app.kill();
  }
});
