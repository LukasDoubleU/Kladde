// Windows integration (default editor offer, file associations, context menu).
//
// SAFETY: an isolated profile (KLADDE_DATA_DIR, which launch() sets) never writes the real registry. The app
// then uses the throwaway key HKCU\Software\KladdeTest\<KLADDE_TEST_KEY> instead of HKCU\Software, and it never
// notifies the shell or opens the Windows settings. This test deletes that key afterwards and checks that
// the real keys were not touched.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { DEBUG_EXE, launch, removeProfile, tempProfile } from "./kladde.mjs";

const PORT = 9347;
const KEY = `e2e-${process.pid}-${Date.now()}`;
const TEST_BASE = `HKCU\\Software\\KladdeTest\\${KEY}`;
const env = { KLADDE_TEST_KEY: KEY, KLADDE_TEST_OFFER: "1" };
const profiles = [];

function reg(...args) {
  try {
    return execFileSync("reg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Real keys that Kladde must never touch from a test run. */
function realState() {
  return {
    app: reg("query", "HKCU\\Software\\Kladde", "/s"),
    prog: reg("query", "HKCU\\Software\\Classes\\Kladde.Document", "/s"),
    menu: reg("query", "HKCU\\Software\\Classes\\*\\shell\\Kladde", "/s"),
    registered: reg("query", "HKCU\\Software\\RegisteredApplications", "/v", "Kladde"),
    openWith: reg("query", "HKCU\\Software\\Classes\\.md\\OpenWithProgids", "/s"),
  };
}
const before_ = realState();

function newProfile() {
  const p = tempProfile("kladde-integration");
  profiles.push(p);
  return p;
}

function start(profile) {
  return launch({ port: PORT, profile, env });
}

const clickButton = (app, text) =>
  app.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!b) return false;
    b.click();
    return true;
  })()`);

const hasOffer = (app) => app.eval("!!document.querySelector('.offer')");
const notice = (app) => app.eval("document.querySelector('.notice span')?.textContent ?? null");

async function offerAppears(app) {
  try {
    await app.waitFor("document.querySelector('.offer')", 3000);
    return true;
  } catch {
    return false;
  }
}

async function offerStaysAway(app) {
  await new Promise((r) => setTimeout(r, 1500));
  return !(await hasOffer(app));
}

async function runCommand(app, query) {
  await app.key("Ctrl+Shift+P");
  await app.waitFor("document.querySelector('.picker input')");
  await app.type(query);
  await new Promise((r) => setTimeout(r, 100));
  await app.key("Enter");
}

before(() => {
  assert.equal(reg("query", TEST_BASE), null, "the test key must not exist yet");
});

after(async () => {
  reg("delete", TEST_BASE, "/f");
  // Remove the shared parent too when nothing else is in it.
  const parent = reg("query", "HKCU\\Software\\KladdeTest");
  if (parent !== null && !parent.split(/\r?\n/).some((l) => l.trim().startsWith("HKEY_CURRENT_USER\\Software\\KladdeTest\\"))) {
    reg("delete", "HKCU\\Software\\KladdeTest", "/f");
  }
  for (const p of profiles) await removeProfile(p);
  assert.equal(reg("query", TEST_BASE), null, "test key left behind");
  assert.deepEqual(realState(), before_, "the real registry was touched");
});

test("the offer: not now hides it for the session, don't ask again for good", async () => {
  const profile = newProfile();
  let app = await start(profile);
  try {
    assert.ok(await offerAppears(app), "offer is shown when nothing is registered");
    assert.ok(await clickButton(app, "Not now"));
    assert.ok(!(await hasOffer(app)));
  } finally {
    await app.close();
  }

  app = await start(profile);
  try {
    assert.ok(await offerAppears(app), "Not now does not persist");
    assert.ok(await clickButton(app, "Don’t ask again"));
    assert.ok(!(await hasOffer(app)));
  } finally {
    await app.close();
  }

  app = await start(profile);
  try {
    assert.ok(await offerStaysAway(app), "Don't ask again persists");
  } finally {
    await app.close();
  }
  assert.equal(reg("query", TEST_BASE), null, "dismissing must not register anything");
});

test("registers chosen file types and the context menu, then removes everything", async () => {
  const profile = newProfile();
  let app = await start(profile);
  try {
    assert.ok(await offerAppears(app));
    assert.ok(await clickButton(app, "Choose file types…"));
    await app.waitFor("document.querySelector('.dialog .options')");
    const labels = await app.eval(`[...document.querySelectorAll('.dialog .option')].map((o) => o.textContent.trim())`);
    assert.equal(labels.length, 6, "five file type groups and the context menu");
    assert.match(labels[0], /^Plain text/);
    assert.match(labels[5], /Edit with Kladde/);
    // Opt out of the log files.
    await app.eval(`[...document.querySelectorAll('.dialog .option')].find((o) => o.textContent.includes('Log files')).querySelector('input').click()`);
    assert.ok(await clickButton(app, "Register and open Windows settings"));
    await app.waitFor("document.querySelector('.notice')");
    assert.match(await notice(app), /registered/);
    assert.ok(!(await hasOffer(app)));
    assert.ok(!(await app.eval("!!document.querySelector('.dialog')")), "dialog closed");

    const groups = reg("query", `${TEST_BASE}\\Kladde`, "/v", "Groups");
    assert.match(groups, /text,markdown,data,code/);
    assert.doesNotMatch(groups, /logs/);
    assert.match(reg("query", `${TEST_BASE}\\Kladde\\Capabilities\\FileAssociations`, "/v", ".md"), /Kladde\.Document/);
    assert.equal(reg("query", `${TEST_BASE}\\Kladde\\Capabilities\\FileAssociations`, "/v", ".log"), null);
    assert.ok(reg("query", `${TEST_BASE}\\Classes\\*\\shell\\Kladde\\command`));
    assert.ok(reg("query", `${TEST_BASE}\\Classes\\.md\\OpenWithProgids`, "/v", "Kladde.Document"));
    assert.ok(reg("query", `${TEST_BASE}\\RegisteredApplications`, "/v", "Kladde"));
    assert.ok(reg("query", `${TEST_BASE}\\Classes\\Kladde.Document\\shell\\open\\command`).toLowerCase().includes(resolve(DEBUG_EXE).toLowerCase()));

    // The context menu entry can be switched off on its own.
    await runCommand(app, "Toggle “Edit with Kladde”");
    await app.waitFor("document.querySelector('.notice')?.textContent.includes('removed')");
    assert.equal(reg("query", `${TEST_BASE}\\Classes\\*\\shell\\Kladde`), null);
    assert.ok(reg("query", `${TEST_BASE}\\Kladde\\Capabilities`), "file types stay");
  } finally {
    await app.close();
  }

  // Registered: no offer on the next start.
  app = await start(profile);
  try {
    assert.ok(await offerStaysAway(app), "no offer while registered");
    await runCommand(app, "Remove Kladde from Windows");
    await app.waitFor("document.querySelector('.notice')?.textContent.includes('removed')");
    assert.equal(reg("query", `${TEST_BASE}\\Kladde`), null);
    assert.equal(reg("query", `${TEST_BASE}\\Classes\\Kladde.Document`), null);
    assert.equal(reg("query", `${TEST_BASE}\\Classes\\.md`), null, "no empty .md key left behind");
    assert.equal(reg("query", `${TEST_BASE}\\RegisteredApplications`), null);
  } finally {
    await app.close();
  }

  // Removing means no, so the offer stays away.
  app = await start(profile);
  try {
    assert.ok(await offerStaysAway(app));
  } finally {
    await app.close();
  }
});

test("a registration for a moved exe is refreshed silently at start", async () => {
  const profile = newProfile();
  let app = await start(profile);
  try {
    await app.eval(`window.__TAURI_INTERNALS__.invoke('integration_register', { groups: ['markdown'], contextMenu: true })`);
  } finally {
    await app.close();
  }
  // Pretend the exe lived somewhere else when it was registered.
  assert.ok(reg("add", `${TEST_BASE}\\Kladde`, "/v", "Exe", "/d", "C:\\old place\\kladde.exe", "/f") !== null);
  assert.ok(reg("add", `${TEST_BASE}\\Classes\\Kladde.Document\\shell\\open\\command`, "/ve", "/d", '"C:\\old place\\kladde.exe" "%1"', "/f") !== null);

  app = await start(profile);
  try {
    assert.ok(await offerStaysAway(app), "a stale registration is refreshed, not offered again");
    const exe = reg("query", `${TEST_BASE}\\Kladde`, "/v", "Exe");
    assert.ok(exe.toLowerCase().includes(resolve(DEBUG_EXE).toLowerCase()), exe);
    const cmd = reg("query", `${TEST_BASE}\\Classes\\Kladde.Document\\shell\\open\\command`, "/ve");
    assert.ok(cmd.toLowerCase().includes(resolve(DEBUG_EXE).toLowerCase()), cmd);
    assert.ok(reg("query", `${TEST_BASE}\\Classes\\*\\shell\\Kladde`), "the context menu entry survives the refresh");
  } finally {
    await app.close();
  }
});

test("--unregister-integration removes the registration (what the uninstaller runs)", async () => {
  const profile = newProfile();
  const app = await start(profile);
  try {
    await app.eval(`window.__TAURI_INTERNALS__.invoke('integration_register', { groups: ['text', 'code'], contextMenu: true })`);
    assert.ok(reg("query", `${TEST_BASE}\\Kladde`));
    // A second process with the same (isolated) profile, while the first one is still running.
    const run = spawnSync(DEBUG_EXE, ["--unregister-integration"], {
      env: { ...process.env, ...env, KLADDE_DATA_DIR: `${profile}\\data` },
      timeout: 15000,
    });
    assert.equal(run.status, 0);
    assert.equal(reg("query", `${TEST_BASE}\\Kladde`), null);
    assert.equal(reg("query", `${TEST_BASE}\\Classes\\*\\shell\\Kladde`), null);
    assert.equal(reg("query", `${TEST_BASE}\\Classes\\Kladde.Document`), null);
  } finally {
    await app.close();
  }
});
