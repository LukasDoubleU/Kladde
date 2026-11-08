# Testing

## Overview

| Command | What it covers | Needs |
|---|---|---|
| `npm run check` | svelte-check (types of all `.ts`/`.svelte`) | — |
| `npm run test:unit` | Node's test runner on `tests/unit/*.test.mjs`: formatters, keys/presets, grammar text side, themes, settings metadata, update manifest, last-check time format, link finding and heading anchors, the CSP and the asset scope in `tauri.conf.json` | — |
| `cd src-tauri && cargo test` | file I/O and encodings (binary and lossy flags), safe saving, large viewer (index, search, piece table, editing, streaming save, journal), LanguageTool client (local socket), local LanguageTool (hash check, download, atomic install, version cleanup, routing, idle stop, start/stop/crash of a stand-in process, job object), registry code (throwaway key), updater helpers, the URL classification of the navigation guard | Rust |
| `npm run test:e2e` | the real app through the DevTools protocol: `tests/e2e/*.test.mjs` | `npx tauri build --debug --no-bundle` first |

Run all four before merging anything. For e2e prefer `node --test --test-concurrency=1 "tests/e2e/*.test.mjs"`:
one app at a time is slower but much more stable.

Unit tests import TypeScript sources directly (`node --experimental-strip-types` semantics): modules they load must
import each other with the `.ts` extension, and must not use TypeScript-only runtime syntax (enums, parameter
properties). `tsconfig.json` has `allowImportingTsExtensions` for that.

## The e2e harness (`tests/e2e/kladde.mjs`)

`launch({ port, profile, files, env })` starts `src-tauri/target/debug/kladde.exe` with:

- `KLADDE_DATA_DIR=<profile>/data`: isolated settings, session, backups (and no single-instance hand-off);
- `KLADDE_DEVTOOLS_PORT=<port>`: Kladde itself passes `--remote-debugging-port` to WebView2 (and puts the WebView2
  profile into `<profile>/data/webview`). WebView2's own variables (`WEBVIEW2_USER_DATA_FOLDER`,
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) are not honored on the GitHub runner, so the harness drops inherited
  `WEBVIEW2_*` variables and does not use them.

A test instance never shows up on the desktop: its window is created unfocused and unfocusable, without taskbar
button, and moved far off screen (`create_main_window` and `show_in_background` in `lib.rs`); the browser
arguments keep an off-screen page rendering (no occlusion detection, no background throttling). Never work around
this when running tests, and never start `kladde.exe` by hand without `KLADDE_DATA_DIR`.

`launch()` waits for a free DevTools port (a dying WebView2 keeps serving the old page for a moment), then for
`document.documentElement.dataset.ready`, which the app sets when startup is over (session restored, command-line
files opened); acting earlier races with the restore. A start that fails is cleaned up (process killed, socket
closed) and reports the app's stderr.

It connects over CDP and returns helpers: `key("Ctrl+Shift+P")`, `type(text)`, `eval(expr)`, `waitFor(expr)`,
`state()` (tabs, active, dirty, editor text, dialog, notice), `wheel`, `click` (DOM `click()`; real mouse input goes through `app.cdp.send("Input.dispatchMouseEvent", …)`, see `links.test.mjs`), `screenshot(path, {width,height})`,
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
| binary-save | 9413–9419 (one app at a time; every port is reused once or twice) |
| hot-exit | 9344, 9354–9358, 9380, 9390, 9400–9404 |
| integration | 9347 |
| keys | 9350–9351, 9384–9386 |
| links | 9405–9412 |
| navigation | 9420–9426, 9441–9444 |
| languagetool-local | 9369–9370, 9374–9375, 9377–9379 |
| large | 9345, 9391–9393, 9397–9399 (the editing tests reuse earlier ports one app at a time) |
| preview | 9346, 9376 |
| settings | 9352–9353 |
| theme | 9348, 9381–9383 |
| update | 9349, 9359–9362, 9366–9368, 9394–9396 |

Free for new files: 9445 and up (9380 and 9390 are taken by hot-exit now).

## Environment variables

| Variable | Effect (only together with `KLADDE_DATA_DIR` where noted) |
|---|---|
| `KLADDE_DATA_DIR` | Isolated profile: data and config folder, no single instance, registry writes go to a test key, no automatic update check |
| `KLADDE_DEVTOOLS_PORT` | Passes `--remote-debugging-port=<port>` to WebView2 (isolated profile only; never in a normal run: an open debugging port would let any local program drive the editor) |
| `KLADDE_TEST_KEY` | Name of the registry test key `HKCU\Software\KladdeTest\<key>` used by an isolated profile |
| `KLADDE_TEST_OFFER=1` | Shows the default-editor offer in an isolated profile |
| `KLADDE_UPDATE_URL` | Update manifest URL (isolated profile only); tests serve a fake `latest.json` |
| `KLADDE_UPDATE_PERIOD_SECS` | Period of the automatic check of a running app in seconds, and no one-hour throttle (isolated profile only); the real period is 6 h |
| `KLADDE_LT_DOWNLOADS` | JSON `{"languagetool": {url, sha256, size}, "java": {…}}` replacing the pinned downloads of the local LanguageTool (isolated profile only); tests serve small zips |
| `KLADDE_LT_COMMAND` | JSON array `[program, args…]` started instead of Java for the local LanguageTool; Kladde appends `--port <n>` (isolated profile only) |
| `KLADDE_LT_IDLE_SECS` | Idle time in seconds after which the local LanguageTool stops, instead of 15 minutes (isolated profile only) |
| `KLADDE_SESSION_DELAY_MS` | Waits this many ms before every write of `session.json` (isolated profile only); with the old write order it holds the session back after the backups, so a test can kill Kladde inside that window |
| `KLADDE_BACKUP_DELAY_MS` | Waits this many ms before every write of a text backup (isolated profile only); the window between the session naming a tab and its backup being written |
| `KLADDE_OPEN_URL_LOG` | File that receives every external link (http, https, mailto) one URL per line, instead of the browser starting (isolated profile only); tests assert the URL that would have been opened |
| `KLADDE_E2E_START_TIMEOUT` | Harness: how long to wait for the app to come up (ms, default 20000; CI uses 90000) |

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
- **LanguageTool:** e2e tests run a fake server in the test; never point tests at the public API. The local
  LanguageTool is tested with the overrides above, never with the real 300 MB downloads (CI must not fetch them):
  `languagetool-local.test.mjs` serves two small zips (`zip.mjs` writes them) and starts `fake-languagetool.mjs`
  (a Node script with the LanguageTool API, `fake-lt.mjs` is the matching logic it shares with `grammar.test.mjs`)
  in place of Java. It covers: the offer dialog, progress and cancel, install, findings through the managed server
  ("Starting LanguageTool…" in between, no error), the process ending when Kladde is killed, idle stop and restart,
  off, removal (also while running), a configured server winning, a checksum mismatch, a server that fails to start,
  a server that died while running, and declining the public API. The fake does not slow the check down, so the real startup is not exercised there:
  a manual run with the real downloads (isolated temp profile, English and German text, memory and timings) is the
  check before changing the pinned versions or the Java flags. Real extraction speed: `KLADDE_TEST_ZIP=<zip> cargo
  test real_extract -- --ignored --nocapture`.
  Kladde starts the server with the LanguageTool folder inside the profile as its working directory, which Windows
  does not let anyone delete: tests end the server (by killing Kladde, which closes the job object) before
  `removeProfile`, and the `after` hook kills stragglers.
- **Navigation and the asset protocol** (`navigation.test.mjs`): navigations are started from the page
  (`location.assign`, `window.open` with a user gesture through `Runtime.evaluate`) and through `Page.navigate`.
  `KLADDE_OPEN_URL_LOG` records the web and mail links the guard hands to the system; everything else must stay out
  of it. Clicks that must not navigate are real mouse events (`Input.dispatchMouseEvent`, also on an `<area>`
  injected into the page to get past the sanitizer); addresses `Url::parse` rejects (`http://xn--a.invalid/`) are
  tried too, because Tauri lets them through. A `window.__marker` set in the page proves it was not replaced; the tab state, with an unsaved edit, that
  nothing was lost. What the asset protocol answers is read from `Network.responseReceived` on a *second* DevTools
  connection (the page's CSP stops a `fetch` of the test, and an `<img>` only tells image from no image). The
  context menu is tested with synthetic `contextmenu` events: they never open WebView2's native menu, which must not
  appear on the desktop; a real right click through `Input.dispatchMouseEvent` might.
- **Large files:** lower `largeFileThresholdMB` in the isolated profile's `settings.json` instead of generating
  huge fixtures; delete generated files. Editing tests focus `.large .input` (the hidden textarea), type with
  `type()`/`key()` and check `.large .line .text`; a kill is only safe once the journal in `data/backup`
  (`*.large.json`, `addedLen`) has caught up with the edits. Real-size measurements: `cargo test --release
  perf_200mb -- --ignored --nocapture` (generates and deletes a ~190 MB file in the temp folder).
- **Files that are not text:** `binary-save.test.mjs` compares SHA-256 (and mtime, to prove nothing was written)
  of generated files before and after Ctrl+S: a binary blob with lone CR bytes, a .docx-like stored zip (`zip.mjs`),
  a text file with mixed line endings, the same in the large viewer (threshold lowered), the read-only banner, "Edit
  anyway", the confirmation dialog (Cancel, then Save anyway), and a crash with an edited and an unedited binary tab (also a restored text tab that later turns lossy, a discarded large
  journal, a file that vanishes and returns, and grammar checking, which skips read-only tabs; a fake LanguageTool
  records what it is sent).
  The zip is named `.zip`, not `.docx`, so the test does not depend on how Kladde routes Office files.
- **Data loss:** any change to saving, backups or the session must be verified by killing the app with unsaved
  changes and checking the restore (`hot-exit.test.mjs` does it; it also proves the typing throttle by failing
  with the old 1 s debounce). The write order of a session save (session, then backups, then pruning) is pinned with
  the two delay variables above: the tests kill Kladde while a write is held back (backups written, session slow;
  session written, backup slow) and check the restore. They fail with the old order (backup first): the first
  with the "fewer tabs after the restart" timeout that used to show up as a flaky CI failure. A session that names
  missing and older backups is also written by hand and restored. In the plain crash test, "the backups exist"
  now implies "the session lists them", which it asserts before the kill: that was the CI race.

## Known flakiness

Occasional timeouts used to show up in long sequential runs while the tests passed alone (theme, grammar,
integration, preview, compare). The causes were hidden timing assumptions, not slow machines:

- the editor takes the focus one frame after a tab switch (`activate`), which took it from a command palette
  opened in between: the first `Ctrl+Shift+P` after a slow start, also on a locked screen (compare, theme).
  It was an app bug, not a test problem: the frame callbacks now leave the focus alone while a picker or dialog
  is open (regression test in `keys.test.mjs`). `launch()` also waits for `data-ready`, so tests do not race the
  session restore either;
- the large file viewer lacked its last line when a partly written line was completed while the indexer ran
  (fixed in the view; reproduced by running the test under CPU load);
- connecting to the dying WebView2 of the previous launch on the same port: `launch()` waits until the port is free;
- a rejected Tauri command only read "Uncaught (in promise)": `eval()` now reports the rejection value.

When a test times out, find the UI state it should have waited for (`waitFor`) instead of raising the timeout or
sleeping. `key("Ctrl+Shift+P")` reports the focus state when the palette does not come up.

## CI

- `.github/workflows/ci.yml`: job `check` (commit messages, svelte-check, frontend build, `cargo test`) and job
  `e2e` are both required. `e2e` builds the debug app (`windows-latest`, WebView2 preinstalled), runs the smoke
  test, then all e2e tests one at a time (`--test-concurrency=1 --test-timeout=180000`, start timeout 90 s), and
  runs a diagnostics step when something failed (processes, WebView2 command line, DevTools endpoint, stderr).
  Steps have timeouts, so a hang fails the job instead of blocking it for hours.
- The runner's interactive session has a desktop, so the windows are real, but off screen like locally.
  WebView2 there ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`; that is why Kladde passes the port itself.
- A full run takes about 5 minutes. CI only runs for pull requests and pushes to `main`; pushes to `main` cancel
  the running CI of the previous push (concurrency group), so check the latest run.
