// Writes latest.json, the manifest Kladde's updater (tauri-plugin-updater) reads from
//   https://github.com/<owner>/Kladde/releases/latest/download/latest.json
// Usage: node scripts/make-update-manifest.mjs <version> <setup.exe> <repo> <tag> > latest.json
// <setup.exe> is the signed installer; its signature is read from <setup.exe>.sig, which `tauri build`
// writes when bundle.createUpdaterArtifacts is on and TAURI_SIGNING_PRIVATE_KEY is set.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** The manifest object. `signature` is the content of the .sig file, `url` where the installer is downloaded. */
export function updateManifest({ version, notes, signature, url, date = new Date() }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Not a semantic version: ${version}`);
  if (!signature.trim()) throw new Error("The signature is empty");
  return {
    version,
    notes,
    pub_date: date.toISOString(),
    platforms: {
      "windows-x86_64": { signature: signature.trim(), url },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, setup, repo, tag] = process.argv.slice(2);
  if (!version || !setup || !repo || !tag) {
    console.error("Usage: node scripts/make-update-manifest.mjs <version> <setup.exe> <repo> <tag>");
    process.exit(1);
  }
  const releasePage = `https://github.com/${repo}/releases/tag/${tag}`;
  const manifest = updateManifest({
    version: version.replace(/^v/, ""),
    notes: `Kladde ${tag}. Release notes: ${releasePage}`,
    signature: readFileSync(`${setup}.sig`, "utf8"),
    url: `https://github.com/${repo}/releases/download/${tag}/${basename(setup)}`,
  });
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}
