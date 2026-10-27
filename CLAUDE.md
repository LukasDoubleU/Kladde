# Kladde

A lightweight text editor for Windows: a Notepad++ replacement with first-class Markdown. It is deliberately
not an IDE: single files in tabs, no project tree, no Git, no language servers. Priorities, in order: zero
data loss, then speed and lightness, then features.

This repository is public. Keep personal information, machine names, private paths and anything
employer-related out of code, commits, issues and release notes.

## Layout

- `src-tauri/src/`: the Rust core.
  - `files.rs`: reading and writing, encodings, line endings.
  - `large.rs`: the large file viewer (background line index, positional reads).
  - `session.rs`: session, backups of unsaved text, config files.
  - `lib.rs`: Tauri commands and plugins.
- `src/lib/`: frontend logic.
  - `workspace.svelte.ts`: tabs, open, save, close, reload, external changes, preview, session (hot exit).
  - `editor.ts`: CodeMirror setup. `actions.ts`: commands and keybindings. `languages.ts`: detection.
  - `markdown.ts`: preview rendering. `format.ts`: JSON formatter. `settings.svelte.ts`: settings.
- `src/components/`: Svelte components. `src/App.svelte`: layout, the command list and window events.
- `src/app.css`: theme colors as CSS variables (Catppuccin Mocha block, light theme).

All text tabs share one CodeMirror `EditorView`; inactive tabs keep their `EditorState` in a plain map.
Never put CodeMirror objects into Svelte `$state`.

## Commands

```sh
npm install           # also installs the commit-msg hook (core.hooksPath = .githooks)
npm run check         # svelte-check
npm run build         # frontend only
npm run tauri dev     # app with hot reload
npm run tauri build   # release exe and installer
cd src-tauri && cargo test
```

## Commits and versions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `<type>[(scope)][!]: <description>`. The hook and CI both run `scripts/check-commit-msg.sh`.
- Types: `feat` (user-visible feature), `fix`, `perf`, `refactor`, `docs`, `style`, `test`, `build`, `ci`,
  `chore`, `revert`. Optional scopes name the area, e.g. `editor`, `preview`, `large`, `session`, `files`,
  `ui`, `keys`, `theme`, `release`.
- Breaking changes get `!` or a `BREAKING CHANGE:` footer. Command ids (used in `keybindings.json`), setting
  names and the session format are public interfaces, so renaming them is breaking.
- Versions follow [Semantic Versioning](https://semver.org). Never bump versions or edit `CHANGELOG.md` by
  hand: the Release workflow (Actions → Release → Run workflow) derives the next version from the commits
  with git-cliff (`cliff.toml`), sets it via `scripts/set-version.mjs`, builds and tests, commits
  `chore(release): vX.Y.Z`, tags it and publishes the release with the changelog and the exe files. Before
  1.0.0, features and breaking changes bump the minor version and everything else the patch. A dry run
  builds and previews the notes without releasing.
- Preview the next changelog locally with `npx git-cliff --unreleased`.

## Code

- Comments explain why, not what; match the surrounding style.
- New setting: add it to `Settings` and `defaultSettings` in `settings.svelte.ts` and to the README table.
- New command: register it in the action list in `App.svelte` (id, label, default keys); the README lists
  the important shortcuts.

## Testing

- `cargo test` covers file I/O and the large file viewer; `npm run check` type-checks the frontend.
- To check the running app, start the debug build with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` and drive the WebView through the
  Chrome DevTools Protocol (`Input.dispatchKeyEvent`, `Input.insertText`, `Runtime.evaluate`,
  `Page.captureScreenshot`). Never send keystrokes to the desktop. Start with an empty app data folder
  (`%APPDATA%\io.github.lukasdoubleu.kladde`) and remove it afterwards.
- Changes to saving, backups or the session must be checked by killing the process while there are unsaved
  changes and verifying that everything comes back after a restart.
