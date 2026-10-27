# Development

## Setup

- Windows with Node.js 20+ (24 is used), Rust stable with the MSVC toolchain and the Visual Studio C++ Build Tools
  (VCTools workload). WebView2 ships with Windows 11.
- `npm install` also points `core.hooksPath` at `.githooks` (commit-msg check).
- First Rust build of a fresh checkout takes several minutes; `src-tauri/target` grows to ~5 GB per checkout.
- App builds: `npx tauri build --debug --no-bundle` for testing (fast, embeds the frontend), `npm run tauri dev`
  for hot reload, `npm run tauri build` for the optimized exe and installer (LTO, slow; normally only CI does it).
- A built exe is locked while it runs; stop running test instances before rebuilding.

## How work is organized

- Every feature or bug is a GitHub issue; commits reference it (`Refs #n`, the finishing one `Closes #n`).
- Larger batches were done with one agent per issue, each in its own git worktree and branch
  (`git worktree add -b issue/<n>-<slug> ../kladde-worktrees/issue-<n> main`), committing but not pushing. A
  coordinator reviews each branch, rebases it onto `main`, runs **all** checks (see [testing.md](testing.md)) on
  the combined state, fast-forwards `main`, pushes and removes the worktree. Merging one branch at a time keeps
  conflicts small.
- Give each parallel agent its own e2e ports and keep its edits to shared files additive (command list in
  `App.svelte`, `settings.svelte.ts`, README tables, `package.json`).

### Typical merge conflicts

- `package-lock.json` / `Cargo.lock`: take `main`'s version, then `npm install` / let cargo update the lock (e.g.
  `cargo metadata`), and commit the result. Never hand-merge lockfiles.
- `package.json` / `Cargo.toml` dependency lists, the command list in `App.svelte`, README tables, CLAUDE.md
  notes: usually "keep both sides".
- Beware "keep both" in CSS and settings: themes moved from `app.css` to `themes.css`, so colors added by an older
  branch to `app.css` belong into the role block of `themes.css`, and old duplicate setting definitions must go.
- After resolving: `npm run check` catches most leftovers.

## Commits

- Conventional Commits, enforced by `.githooks/commit-msg` and CI (`scripts/check-commit-msg.sh`). Types and scopes
  are listed in CLAUDE.md. Commit bodies explain why.
- Commits that predate the convention (the first ones up to the README) appear as "Other changes" in the first
  changelog; public history is never rewritten.

## Releases

- Only through the **Release** workflow (Actions → Release → Run workflow, `bump`: auto/patch/minor/major,
  `prerelease`, `dry_run`). It runs on `windows-latest`, refuses other branches than `main`, and:
  1. computes the next version with git-cliff (`cliff.toml`; before 1.0 features and breaking changes bump the
     minor), fails if the tag exists (no new commits);
  2. sets it everywhere with `scripts/set-version.mjs` (package.json, package-lock.json, tauri.conf.json,
     Cargo.toml, Cargo.lock);
  3. type-checks, runs `cargo test`, builds (signed updater artifacts when the `TAURI_SIGNING_PRIVATE_KEY` secret
     exists, via `src-tauri/tauri.updater.conf.json`);
  4. collects `Kladde_X.Y.Z_x64-setup.exe`, `Kladde_X.Y.Z_x64_portable.exe`, `SHA256SUMS.txt` and, when signed,
     `…-setup.exe.sig` and `latest.json` (`scripts/make-update-manifest.mjs`);
  5. writes `CHANGELOG.md` and the release notes (git-cliff + `.github/release-footer.md`);
  6. commits `chore(release): vX.Y.Z` as github-actions[bot], tags, pushes to `main` and publishes the release.
- When the workflow itself changed, run a **dry run** first: it does everything except commit/tag/publish and
  uploads the files and notes as an artifact.
- After a release, pull `main` (the bot commit) before continuing.
- The updater key pair: public key in `tauri.conf.json` (`plugins.updater.pubkey`), private key only as the
  repository secret. Never commit it, never replace it: installed copies could no longer update.
- `cliff.toml` gotcha: write regexes as TOML literal strings (`'^chore\(release\)'`); escaping in basic strings
  is easy to get wrong and silently changes the pattern.

## Windows, WebView2 and Tauri pitfalls

- WebView2 handles browser accelerators (F5 reload, Ctrl+P print, Ctrl+F find bar, F7 caret browsing, Ctrl+wheel
  zoom) unless the page calls `preventDefault`; `App.svelte` swallows them and maps zoom to the editor font size.
- Tauri file drag and drop disables HTML5 drag and drop in the page (tabs are reordered with pointer events).
- The mouse back/forward buttons would navigate the WebView's history; they are captured (`button` 3/4).
- CodeMirror injects inline styles: the CSP needs `'unsafe-inline'` for styles and Tauri must not add hashes
  (`dangerousDisableAssetCspModification: ["style-src"]`).
- The page cannot reach arbitrary HTTP servers (CSP, CORS): such requests go through Rust commands.
- `Emulation.setFocusEmulationEnabled` and other CDP tricks only exist for tests; production code must not rely on
  them.
- `ReplaceFileW` fails on some file systems or locked files; `write_safely` then writes in place.

## Svelte 5 pitfalls

- Never put CodeMirror objects (`EditorView`, `EditorState`, merge views) into `$state`; keep them in plain maps or
  plain class fields.
- Objects pushed into a `$state` array are proxied; mutate the element taken from the array (`this.tabs.find(…)`,
  `workspace.active`), not the original object you pushed.
- When building objects from partial input, put defaults first and computed values after the spread: an explicit
  `id: undefined` in the input once overwrote generated ids, so every tab had the same key and the keyed `each`
  threw (`each_key_duplicate`), freezing the UI.
- `$effect`s that call into CodeMirror can pick up reactive reads from inside the dispatch; wrap such calls in
  `untrack`.
- Frontend errors go to `window.onerror` → `frontend_log` (stderr of a debug build) and an error notice; error
  notices are also logged, which helps when testing a debug build.

## Adding things

- **Setting:** `Settings` + `defaultSettings` in `settings.svelte.ts` (flat, typed: `loadSettings` ignores values
  of the wrong type), README settings table, and wherever it applies (often an `$effect` in `App.svelte` or
  `applyViewOptions`).
- **Command:** an action in `App.svelte` (or `editorCommands` in `editor-actions.ts` for text commands) with a
  stable id, a label and default keys that don't clash (`tests/unit/keys.test.mjs` checks). README shortcut table
  for important ones.
- **Language:** `@codemirror/language-data` covers most; extension overrides and own stream parsers live in
  `languages.ts`. Formatters are mapped by language name in `formatters.ts`.
- **Colored UI:** a role variable in `themes.css` (built from the palette), `THEME_VARIABLES` in `theme.ts`, README
  theming table; never literal colors in components.
- **Big dependency:** dynamic `import()` at the point of use, and report the chunk size (`npm run build`).
