# Kladde

A lightweight text editor for Windows: a Notepad++ replacement with first-class Markdown. It is deliberately
not an IDE: single files in tabs, no project tree, no Git, no language servers. Priorities, in order: zero
data loss, then speed and lightness, then features.

This repository is public. Keep personal information, machine names, private paths and anything
employer-related out of code, commits, issues and release notes.

## Layout

- `src-tauri/src/`: the Rust core.
  - `files.rs`: reading and writing, encodings, line endings.
  - `large.rs`: the large file viewer (background line index that grows with the file, positional reads,
    UTF-16, chunked plain/regex search that runs on the blocking pool and can be cancelled).
  - `session.rs`: session, backups of unsaved text, config files.
  - `integration.rs`: Windows registration (ProgID, capabilities, "Open with", context menu) under a
    registry root passed in, never hard-coded. `src-tauri/windows/installer-hooks.nsh` runs
    `kladde.exe --unregister-integration` from the NSIS uninstaller.
  - `update.rs`: update check and install on top of tauri-plugin-updater (commands `update_check`,
    `update_install`); the webview never calls the plugin itself. `src/lib/updates.svelte.ts` and
    `UpdateBanner.svelte` are the user-facing side.
  - `lib.rs`: Tauri commands and plugins.
- `src/lib/`: frontend logic.
  - `workspace.svelte.ts`: tabs, open, save, close, reload, external changes, preview, session (hot exit).
  - `compare.ts`: diff views of compare tabs (`@codemirror/merge`, imported lazily by `Compare.svelte`).
  - `editor.ts`: CodeMirror setup. `actions.ts`: commands, key handling (chords) and keybindings.json.
    `languages.ts`: detection.
  - `keys.ts`: key combos and sequences, conflict rules (no imports, unit tested). `keymaps.ts`: the
    Notepad++ and VS Code presets. `editor-actions.ts`: CodeMirror's editing commands (and our own: join,
    sort, case) as actions. `shortcut-editor.svelte.ts`: "Change keyboard shortcut…" and the preset picker
    (writes keybindings.json / settings.json; dialog in `components/KeyCapture.svelte`).
  - `markdown.ts`: preview rendering. `mermaid.ts`: diagrams (placeholders drawn by `Preview.svelte`, SVGs
    cached by source and theme). `math.ts`: KaTeX rules. Mermaid and KaTeX are dynamic imports: never import
    them statically, so the main bundle stays small. `format.ts`: JSON formatter. `settings.svelte.ts`: settings.
  - `grammar.ts`: LanguageTool checking through `@codemirror/lint` (lazy import, only active while grammar
    checking is on); `grammar-text.ts`: its pure part (Markdown masking, paragraphs, request, offset mapping),
    unit-tested. `src-tauri/src/languagetool.rs` makes the HTTP request (the CSP keeps the page from doing it).
    Nothing is sent unless a server is configured and checking is on; the public server needs a one-time
    consent (localStorage). Never import `grammar.ts` or `@codemirror/lint` statically.
  - `format-xml.ts`: XML formatter. `formatters.ts`: picks a formatter by language name and lazy-loads
    Prettier and sql-formatter.
  - `linehighlight.ts`: highlights the visible lines of the large file viewer with the editor's grammars.
- `src/components/`: Svelte components. `src/App.svelte`: layout, the command list and window events.
- `src/app.css`: global styles and fonts. `src/themes.css`: the four Catppuccin flavors, the 14 accents and the
  role variables built from them (the theming API documented in the README). `src/lib/theme.ts`: picks the flavor
  (`theme`, `themeLight`/`themeDark`, `accent` settings, Windows mode), sets `data-theme`/`data-accent` on the root
  and loads the user's `theme.css` last.

All text tabs share one CodeMirror `EditorView`; inactive tabs keep their `EditorState` in a plain map.
Never put CodeMirror objects into Svelte `$state`.

Compare tabs (`kind: "compare"`) hold two text snapshots in `workspace.compareData` and show them in their
own merge view (`Compare.svelte`, kept alive while hidden). They are not part of the session.
`@codemirror/merge` must stay a dynamic import so the startup bundle does not grow.

## Commands

```sh
npm install           # also installs the commit-msg hook (core.hooksPath = .githooks)
npm run check         # svelte-check
npm run build         # frontend only
npm run test:unit     # formatter tests
npm run tauri dev     # app with hot reload
npm run tauri build   # release exe and installer
cd src-tauri && cargo test
```

## Theming

- Colors exist only as CSS variables (`themes.css`); components and the CodeMirror theme use `var(--…)`, never
  literal colors (shadows and scrims are the exception). New colored UI needs a role variable in `themes.css`,
  the `THEME_VARIABLES` list in `theme.ts` (it generates the theme.css template) and the README table.
- Flavor and accent selectors use `:where()`, so a user's `:root { … }` in theme.css overrides them without a
  more specific selector. Keep it that way. Mermaid reads the variables and redraws on the `kladde-theme` event.
- Latte is the only light flavor (`isLight`); `--accent-fg` must stay readable (4.5:1) on every flavor and accent,
  which `tests/e2e/theme.test.mjs` checks.

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
- Updates: the release workflow signs the installer for tauri-plugin-updater when the repository secret
  `TAURI_SIGNING_PRIVATE_KEY` exists (password secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` optional): it builds
  with `src-tauri/tauri.updater.conf.json` (`createUpdaterArtifacts`), then `scripts/make-update-manifest.mjs`
  writes `latest.json`, and both it and `…-setup.exe.sig` go into the release. Without the secret the build
  works but there is no update data. The app reads `releases/latest/download/latest.json`; the matching public key
  is `plugins.updater.pubkey` in `tauri.conf.json`. Never commit the private key; losing or replacing it means
  installed copies can no longer update (they must be reinstalled by hand). Pre-releases are not offered.
- Code signing (Authenticode, for SmartScreen) is not set up yet; see issue #9.

## Code

- Comments explain why, not what; match the surrounding style.
- New setting: add it to `Settings` and `defaultSettings` in `settings.svelte.ts` and to the README table.
- New command: register it in the action list in `App.svelte` (id, label, default keys); the README lists
  the important shortcuts. Editor commands (anything that works on the text) go into `editorCommands` in
  `editor-actions.ts` instead: `editor.ts` removes their stock CodeMirror bindings, so a key has exactly one
  owner (the action table) and unbinding it in keybindings.json frees it. Typing keys (Enter, Backspace,
  arrows, Home / End, Tab, undo) stay in CodeMirror's keymaps.
- Shortcuts have three layers: the `keys` of the action (the "default" preset, owner decisions: `Ctrl+D` =
  delete line, `Alt+Shift+W`, `Ctrl+T`, `F5`, `Alt+Left` / `Alt+Right`), a preset in `keymaps.ts` (lists only
  what differs; `[]` unbinds) and keybindings.json; a higher layer takes a key from a lower one
  (`resolveBindings`). New default keys must not clash (`tests/unit/keys.test.mjs` checks this and that
  presets name existing commands). A key is also an app-level capture handler (`handleKeydown`), so it runs
  before CodeMirror sees the event; keep that path cheap, it runs on every keystroke.

## Testing

- `npm run test:unit` (Node's test runner, imports the TypeScript sources directly, so modules it loads
  import each other with the `.ts` extension) covers the formatters and the key handling (`keys.test.mjs`).
- `tests/e2e/keys.test.mjs` covers the default keys, presets, chords and the shortcut editor.
- `cargo test` covers file I/O and the large file viewer (UTF-16, regex and Unicode search, incremental
  index); `tests/e2e/large.test.mjs` drives the viewer with a lowered `largeFileThresholdMB` in the isolated
  profile's `settings.json`; `npm run check` type-checks the frontend.
- `npm run test:unit` (Node's test runner, imports the TypeScript sources directly) covers the formatters and the
  text side of grammar checking. Node strips types only: no parameter properties or enums in those files.
- `cargo test` covers file I/O, the large file viewer and the LanguageTool client (against a local socket); `npm run check` type-checks the frontend.
- End-to-end tests (`npm run test:e2e`, after `npx tauri build --debug --no-bundle`) use
  `tests/e2e/kladde.mjs`: it starts the app with an isolated profile (`KLADDE_DATA_DIR`, own WebView2 data)
  and drives it through the Chrome DevTools Protocol (`key`, `type`, `eval`, `state`, `screenshot`, `close`,
  `kill`). Use it for every check of the running app, with a DevTools port of your own when several runs
  happen in parallel. Never send keystrokes to the desktop and never touch the normal profile in
  `%APPDATA%\io.github.lukasdoubleu.kladde`.
- `tests/e2e/grammar.test.mjs` runs a fake LanguageTool server in the test (node http): never point tests at the
  public API.
- `tests/e2e/hot-exit.test.mjs` guards the zero-data-loss promise (crash, close, continuous typing, saving,
  backup versions) and runs in CI (`e2e` job). Backups are throttled (`Workspace.scheduleSession`: first change
  arms a timer, later ones leave it alone), never debounced: keep it that way.
- Registry code must never write the real `HKCU\Software\Classes`, `RegisteredApplications` or `Kladde` keys in
  tests. With `KLADDE_DATA_DIR` set the app uses `HKCU\Software\KladdeTest\<KLADDE_TEST_KEY>` instead and skips
  the shell notification and the Windows settings page; `cargo test` uses a random key of its own. Tests delete
  their key afterwards (see `tests/e2e/integration.test.mjs`). `KLADDE_TEST_OFFER=1` makes an isolated profile
  show the start-up offer.
- Update tests (`tests/e2e/update.test.mjs`) serve a fake `latest.json` from a local server through
  `KLADDE_UPDATE_URL`, which only an isolated profile (`KLADDE_DATA_DIR`) honors. `update_install` refuses to run in
  an isolated profile, so no test can start an installer. A copy of the exe with an empty `uninstall.exe` next to
  it counts as "installed" (that is how the NSIS installer lays it out); without it the exe is portable.
- Changes to saving, backups or the session must be checked by killing the process while there are unsaved
  changes and verifying that everything comes back after a restart.
