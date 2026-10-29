# Testing

## Overview

| Command | What it covers | Needs |
|---|---|---|
| `npm run check` | svelte-check (types of all `.ts`/`.svelte`) | — |
| `npm run test:unit` | Node's test runner on `tests/unit/*.test.mjs`: formatters, keys/presets, grammar text side, themes, update manifest | — |
| `cd src-tauri && cargo test` | file I/O and encodings, safe saving, large viewer (index, search, piece table, editing, streaming save, journal), LanguageTool client (local socket), registry code (throwaway key), updater helpers | Rust |
| `npm run test:e2e` | the real app through the DevTools protocol: `tests/e2e/*.test.mjs` | `npx tauri build --debug --no-bundle` first |

Run all four before merging anything. For e2e prefer `node --test --test-concurrency=1 "tests/e2e/*.test.mjs"`:
one app at a time is slower but much more stable.

Unit tests import TypeScript sources directly (`node --experimental-strip-types` semantics): modules they load must
import each other with the `.ts` extension, and must not use TypeScript-only runtime syntax (enums, parameter
properties). `tsconfig.json` has `allowImportingTsExtensions` for that.

## The e2e harness (`tests/e2e/kladde.mjs`)

`launch({ port, profile, files, env })` starts `src-tauri/target/debug/kladde.exe` with:

- `KLADDE_DATA_DIR=<profile>/data`: isolated settings, session, backups (and no single-instance hand-off);
- `WEBVIEW2_USER_DATA_FOLDER=<profile>/webview`: own WebView2 profile;
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`.

It connects over CDP and returns helpers: `key("Ctrl+Shift+P")`, `type(text)`, `eval(expr)`, `waitFor(expr)`,
`state()` (tabs, active, dirty, editor text, dialog, notice), `wheel`, `click`, `screenshot(path, {width,height})`,
`close()` (like closing the window → hot exit) and `kill()` (like a crash). A profile survives `kill`/`close`, so
relaunching with the same `profile` tests restore. `tempProfile()`, `writeFixture()`, `removeProfile()` help with
folders.

Rules:

- Never send input to the desktop (no SendKeys, no real mouse); the harness only talks to Kladde's page.
- Never touch the normal profile `%APPDATA%\io.github.lukasdoubleu.kladde`.
- Each test file uses its **own DevTools ports** (table below). Use a new port for every launch inside a file:
  reusing a port right after `kill()` can connect to the dying WebView and hang.

| File | Ports |
|---|---|
| smoke | 9340 |
| compare | 9371–9373 |
| format | 9343, 9363–9365 |
| grammar | 9387–9389 |
| hot-exit | 9344, 9354–9358 |
| integration | 9347 |
| keys | 9350, 9384–9386 |
| large | 9345, 9391–9393, 9397–9399 (the editing tests reuse earlier ports one app at a time) |
| preview | 9346, 9376 |
| theme | 9348, 9381–9383 |
| update | 9349, 9394–9396 |

Free for new files: 9351–9353, 9359–9362, 9366–9370, 9374–9375, 9377–9380, 9390.

## Environment variables

| Variable | Effect (only together with `KLADDE_DATA_DIR` where noted) |
|---|---|
| `KLADDE_DATA_DIR` | Isolated profile: data and config folder, no single instance, registry writes go to a test key, no automatic update check |
| `KLADDE_TEST_KEY` | Name of the registry test key `HKCU\Software\KladdeTest\<key>` used by an isolated profile |
| `KLADDE_TEST_OFFER=1` | Shows the default-editor offer in an isolated profile |
| `KLADDE_UPDATE_URL` | Update manifest URL (isolated profile only); tests serve a fake `latest.json` |
| `KLADDE_E2E_START_TIMEOUT` | Harness: how long to wait for the app to come up (ms, default 20000) |

## Pitfalls we hit (and how the harness handles them)

- **Focus:** Kladde checks for external file changes only while its window has focus. The harness enables
  `Emulation.setFocusEmulationEnabled`, so tests do not depend on which window is in front.
- **Command palette:** it opens asynchronously; `key("Ctrl+Shift+P")`/`key("F1")` wait until the picker input has
  focus, otherwise typed text lands in the editor.
- **Text input:** `type()` uses `Input.insertText`, which fires `input` but no key events; CodeMirror's search panel
  only commits on key events, so search highlighting may not update from `type()` alone.
- **Clicks:** tabs react to pointer events; synthetic `PointerEvent`s have no active pointer, so
  `setPointerCapture` throws (guarded by `lib/pointer.ts`). Prefer CDP mouse events (`Input.dispatchMouseEvent`)
  for real clicks.
- **CodeMirror renders only visible lines:** `state().text` is the rendered part; scroll (`Ctrl+End`) to read more.
- **Registry:** tests must never write real association keys (`HKCU\Software\Classes`, `RegisteredApplications`,
  `HKCU\Software\Kladde`). The isolated profile and `cargo test` use `HKCU\Software\KladdeTest\…` and delete it.
  An early bug built `HKCU\SoftwareKladdeTest…` (missing backslash); `target_for` now has a unit test.
- **Updates:** `update_install` refuses to run in an isolated profile; tests never download an installer.
- **LanguageTool:** e2e tests run a fake server in the test; never point tests at the public API.
- **Large files:** lower `largeFileThresholdMB` in the isolated profile's `settings.json` instead of generating
  huge fixtures; delete generated files. Editing tests focus `.large .input` (the hidden textarea), type with
  `type()`/`key()` and check `.large .line .text`; a kill is only safe once the journal in `data/backup`
  (`*.large.json`, `addedLen`) has caught up with the edits. Real-size measurements: `cargo test --release
  perf_200mb -- --ignored --nocapture` (generates and deletes a ~190 MB file in the temp folder).
- **Data loss:** any change to saving, backups or the session must be verified by killing the app with unsaved
  changes and checking the restore (`hot-exit.test.mjs` does it; it also proves the typing throttle by failing
  with the old 1 s debounce).

## Known flakiness

- In a long sequential full run, single tests occasionally time out (seen: theme, grammar public-server
  confirmation, integration) while they pass when run alone. Usually a hidden timing assumption: wait for the
  UI state (`waitFor`) instead of sleeping, and make sure the UI you type into is open. Tracked in issue #11.

## CI

- `.github/workflows/ci.yml`: job `check` (commit messages, svelte-check, frontend build, `cargo test`) is
  required. Job `e2e` builds the debug app and runs the smoke test, then all e2e tests one at a time, and collects
  diagnostics on failure. It is `continue-on-error` for now: on the GitHub runner (Windows Server 2025, WebView2
  155, interactive session) Kladde starts and shows its window, but the DevTools endpoint refuses connections —
  WebView2 there ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. Likely fix: let Kladde pass
  `--remote-debugging-port` itself (window created in `setup()` with `additional_browser_args`) when an isolated
  profile asks for it. Issue #11.
- Pushes to `main` cancel the running CI of the previous push (concurrency group), so check the latest run.
