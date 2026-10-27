// Sets the app version everywhere it is stored. Usage: node scripts/set-version.mjs 1.2.3
import { readFileSync, writeFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <semver>, e.g. 1.2.3");
  process.exit(1);
}

function replace(file, pattern) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) throw new Error(`${file}: no version found`);
  writeFileSync(file, text.replace(pattern, `$1${version}$2`));
}

replace("package.json", /("version":\s*")[^"]+(")/);
replace("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/);
replace("src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion = ")[^"]+(")/);
replace("src-tauri/Cargo.lock", /(name = "kladde"\r?\nversion = ")[^"]+(")/);

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.version = version;
lock.packages[""].version = version;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

console.log(`Version set to ${version}`);
