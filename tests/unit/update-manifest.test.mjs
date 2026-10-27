import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { updateManifest } from "../../scripts/make-update-manifest.mjs";

test("manifest has the shape tauri-plugin-updater reads", () => {
  const m = updateManifest({
    version: "1.2.3",
    notes: "n",
    signature: "c2ln\n",
    url: "https://example.com/Kladde_1.2.3_x64-setup.exe",
    date: new Date("2030-01-02T03:04:05Z"),
  });
  assert.deepEqual(m, {
    version: "1.2.3",
    notes: "n",
    pub_date: "2030-01-02T03:04:05.000Z",
    platforms: { "windows-x86_64": { signature: "c2ln", url: "https://example.com/Kladde_1.2.3_x64-setup.exe" } },
  });
});

test("rejects a bad version and an empty signature", () => {
  assert.throws(() => updateManifest({ version: "v1", notes: "", signature: "x", url: "u" }));
  assert.throws(() => updateManifest({ version: "1.0.0", notes: "", signature: " \n", url: "u" }));
});

test("command line: reads the .sig next to the installer and links the release asset", () => {
  const dir = mkdtempSync(join(tmpdir(), "kladde-manifest-"));
  try {
    mkdirSync(dir, { recursive: true });
    const setup = join(dir, "Kladde_0.2.0_x64-setup.exe");
    writeFileSync(`${setup}.sig`, "U0lHTkFUVVJF\n");
    const out = execFileSync(process.execPath, ["scripts/make-update-manifest.mjs", "0.2.0", setup, "Owner/Kladde", "v0.2.0"], {
      encoding: "utf8",
    });
    const m = JSON.parse(out);
    assert.equal(m.version, "0.2.0");
    assert.match(m.notes, /https:\/\/github\.com\/Owner\/Kladde\/releases\/tag\/v0\.2\.0/);
    assert.deepEqual(m.platforms["windows-x86_64"], {
      signature: "U0lHTkFUVVJF",
      url: "https://github.com/Owner/Kladde/releases/download/v0.2.0/Kladde_0.2.0_x64-setup.exe",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
