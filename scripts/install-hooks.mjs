// Runs on `npm install`: points git at the repo's hooks (Conventional Commits check).
import { execSync } from "node:child_process";

try {
  execSync("git config core.hooksPath .githooks", { stdio: "ignore" });
} catch {
  // Not a git checkout (e.g. an unpacked archive): nothing to install.
}
