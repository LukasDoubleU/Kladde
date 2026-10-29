# Kladde

A lightweight text editor for Windows: a Notepad++ replacement with first-class Markdown — "simple yet powerful
like Notepad++, without becoming an IDE". Single files in tabs; no project tree, no Git, no language servers, no
autocompletion. Priorities, in order: **zero data loss**, then **speed and lightness**, then features.

Stack: Tauri 2 (Rust core, WebView2), CodeMirror 6, Svelte 5 (runes), Vite. Windows only for now.

This repository is **public**. Keep personal information, user or machine names, private paths, credentials and
anything employer-related out of code, commits, issues, release notes and docs.

## Read next

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Modules, data flow, session/hot exit, keys, preview, bundle policy, CSP — and why |
| [docs/decisions.md](docs/decisions.md) | Product decisions and owner preferences (style, default keys, privacy, Windows integration) |
| [docs/testing.md](docs/testing.md) | Unit/Rust/e2e tests, the CDP harness, env vars, port table, pitfalls, CI status |
| [docs/development.md](docs/development.md) | Setup, worktree-per-issue workflow, merge conflicts, releases, Windows/Tauri/Svelte pitfalls, how to add things |
| [docs/roadmap.md](docs/roadmap.md) | Open issues (#9) and known gaps |
| README.md | User-facing features, shortcuts, settings, theming variables |

## Layout (short)

- `src-tauri/src/`: `files.rs` (encodings, `write_safely`), `large.rs` (large file viewer: index, search, editing,
  streaming save, journal), `pieces.rs` (piece table), `session.rs` (session, backups, config, isolated profile),
  `integration.rs` (Windows registration), `update.rs` (updater), `languagetool.rs` (HTTP client), `lib.rs`
  (commands, plugins).
  `src-tauri/windows/installer-hooks.nsh` unregisters on uninstall.
- `src/App.svelte`: layout, command list, window events. `src/lib/workspace.svelte.ts`: tabs, files, session,
  preview, compare, formatting. `src/lib/editor.ts`: CodeMirror setup. Keys: `actions.ts`, `keys.ts`, `keymaps.ts`,
  `editor-actions.ts`, `shortcut-editor.svelte.ts`. Preview: `markdown.ts`, `math.ts`, `mermaid.ts`. Formatting:
  `format.ts`, `format-xml.ts`, `formatters.ts`. Grammar: `grammar.ts`, `grammar-text.ts`. Theme: `theme.ts`,
  `src/themes.css`, `src/app.css`. Others: `languages.ts`, `compare.ts`, `linehighlight.ts`, `settings.svelte.ts`,
  `api.ts`, `integration.svelte.ts`, `updates.svelte.ts`. Large file view: `components/LargeFileView.svelte`,
  `lib/large-edit.ts` (pure helpers, unit-tested).
- `tests/unit/`, `tests/e2e/` (harness `kladde.mjs`), `scripts/` (commit check, version, update manifest),
  `.github/workflows/` (`ci.yml`, `release.yml`), `cliff.toml` (changelog/versions), `docs/`.

## Commands

```sh
npm install                          # also installs the commit-msg hook (core.hooksPath = .githooks)
npm run check                        # svelte-check
npm run test:unit                    # Node test runner on tests/unit
cd src-tauri && cargo test           # Rust tests
npx tauri build --debug --no-bundle  # debug app for e2e tests
npm run test:e2e                     # or: node --test --test-concurrency=1 "tests/e2e/*.test.mjs"
npm run tauri dev                    # app with hot reload
npx git-cliff --unreleased           # preview the next changelog
```

Run check, unit, cargo and e2e tests before merging anything.

## Rules that must not be broken

- **Zero data loss.** Backups are throttled, never debounced (`Workspace.scheduleSession`). Saving goes through
  `write_safely` (large files: `LargeFile::write_to`, which streams the piece table into a temporary file and never
  writes the original in place; their unsaved edits live in a journal that is only valid for an unchanged original).
  Any change to saving, backups or the session must be verified by killing the app with unsaved changes and
  checking the restore (`tests/e2e/hot-exit.test.mjs`, for large files `tests/e2e/large.test.mjs`).
- **Lightweight.** Big dependencies are dynamic imports at the point of use (grammars, `@codemirror/merge`,
  `@codemirror/lint`, Prettier, sql-formatter, Mermaid, KaTeX, `grammar.ts`). Never import them statically.
  Nothing slow at startup.
- **CodeMirror objects never go into Svelte `$state`.** All text tabs share one `EditorView`; inactive tabs keep
  their `EditorState` in a plain map.
- **Colors only as theme variables** (`themes.css` role variables); no literal colors in components.
- **One owner per key.** Commands are actions with stable public ids; editor commands live in `editor-actions.ts`
  and their stock CodeMirror bindings are removed. Default keys include deliberate owner choices (`Ctrl+D` delete
  line, `Alt+Shift+W` reveal, `Ctrl+T`, `F5`, `Alt+Left`/`Alt+Right`) — see docs/decisions.md.
- **Privacy:** nothing leaves the machine unless the user enables it (LanguageTool needs a server and a toggle;
  the public API asks first). The update check contacts GitHub only.
- **Tests never touch the real world:** use the isolated profile (`KLADDE_DATA_DIR`) through the e2e harness, own
  DevTools ports per test file, never send input to the desktop, never write real registry associations, never
  start an installer, never call the public LanguageTool API from tests.

## Commits and versions

- [Conventional Commits](https://www.conventionalcommits.org): `<type>[(scope)][!]: <description>`, checked by the
  hook and CI (`scripts/check-commit-msg.sh`). Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`,
  `build`, `ci`, `chore`, `revert`. Scopes name the area: `editor`, `preview`, `large`, `session`, `files`, `ui`,
  `keys`, `theme`, `compare`, `format`, `grammar`, `integration`, `updater`, `release`, `e2e`. Bodies explain why;
  reference issues with `Refs #n` / `Closes #n`.
- Breaking changes get `!` or a `BREAKING CHANGE:` footer. Public interfaces: command ids (keybindings.json,
  presets), setting names, the session format, theme variable names.
- [Semantic Versioning](https://semver.org). Never bump versions or edit `CHANGELOG.md` by hand: the **Release**
  workflow (on demand, dry run available) derives the version from the commits, builds, tags and publishes. Before
  1.0.0, features and breaking changes bump the minor version, everything else the patch. Details and the updater
  key rules: docs/development.md.

## Code style

- Comments explain why, not what; match the surrounding style (comment density, naming, idioms).
- Keep changes focused; update README (features, shortcuts, settings, theme variables) and these docs when behavior
  or structure changes.
