# Architecture

How Kladde is built and why. For product decisions see [decisions.md](decisions.md), for tests
[testing.md](testing.md), for the workflow [development.md](development.md).

## Stack and why

- **Tauri 2** (Rust core, the system WebView2) instead of a native GUI toolkit. The Markdown preview with images,
  diagrams and math is a core requirement and comes almost for free in a web view; a native editor widget
  (selection, IME, wrapping, undo) would have been months of work. Trade-off accepted: WebView2 needs ~100 MB of
  RAM and a cold start takes a few hundred ms (measured ~0.25–0.5 s to the first window).
- **CodeMirror 6** as the editor: multi-cursor, search, folding, IME and accessibility are solved, it only renders
  the visible part, and Lezer parsing is incremental. Deliberately not used: autocompletion, linting (except the
  opt-in LanguageTool underlines), auto-closing brackets — Kladde is a text editor, not an IDE.
- **Svelte 5** (runes) for the small UI, no SvelteKit; Vite builds a static bundle that Tauri embeds.
- Windows only for now; Rust code that is Windows-specific is behind `cfg(windows)`.

## Rust core (`src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `lib.rs` | Tauri commands, plugins, startup (single instance, `--unregister-integration` CLI flag); `read_document` (raw bytes as a binary IPC response) and `open_in_default_app` for the document viewer |
| `navigation.rs` | What the main webview may navigate to (own origin; web and mail links go to the system; the rest is cancelled) and what a new-window request does: pure URL classification, unit-tested (see "Security and Tauri configuration") |
| `files.rs` | Reading with encoding detection (BOM → UTF-8 validity → chardetng), BOM and line-ending handling, writing with `write_safely`; `read_limited` (a document's bytes, refused above 50 MB, errors that say *too large* / *busy* / *gone*) |
| `large.rs` | The large file viewer backend: index, search, editing, streaming save, hot-exit journal |
| `pieces.rs` | The piece table behind large-file editing (pure data structure, no I/O, no encodings) |
| `session.rs` | Data/config folders, session JSON, backups and backup versions, config files, the isolated profile |
| `integration.rs` | Windows registration (ProgID, capabilities, "Open with", context menu) under a passed-in registry root |
| `update.rs` | Update check/install on top of tauri-plugin-updater |
| `languagetool.rs` | HTTP client for LanguageTool (`ureq`, Windows TLS) |
| `lt_install.rs` | Download, verification and installation of the local LanguageTool and its Java runtime (pinned URLs and SHA-256, `zip`, `sha2`) |
| `lt_server.rs` | The managed local LanguageTool server: routing, lazy start, job object, idle stop |

Key mechanisms:

- **Text model at the boundary:** the editor always works with `\n`. `files::read` normalizes CRLF/CR and reports
  the original `eol`, `encoding`, `bom`, `binary` (NUL bytes) and `lossy` (invalid sequences); `files::write`
  converts back. UTF-16 is encoded by hand (encoding_rs only decodes it). Unmappable characters in a legacy
  encoding are an error, never silently replaced. This round trip is not the identity for files that are not text:
  CR bytes not followed by LF become LF, invalid sequences become U+FFFD. `binary` (a NUL byte anywhere in the file,
  except in UTF-16) and `lossy` are how the page learns to protect such files (see "Files that are not text").
  The large viewer reports both for the first megabyte it reads anyway (`files::sniff_flags`, a streaming
  decode so a character cut by the end of the sample is not counted).
- **Crash-safe saving (`write_safely`):** write a temporary `.<name>.kladde-save` next to the file, `fsync`, then
  `ReplaceFileW`, which keeps attributes, ACLs and creation time (a hidden file stays hidden). Symlinks are resolved
  first. If no temp file can be created, it falls back to writing in place. Session files and backups use it too.
- **Large file viewer (`large.rs`):** never reads the whole file. A background thread builds a line-start index
  (8 MB chunks, `memchr`; 2-byte units for UTF-16), reads are positional (`seek_read`, no memory map, so other
  programs can keep appending), lines are cut at 64 KB for display. Search runs on the blocking pool in ~8 MB chunks
  cut at line breaks, supports regex (`regex` crate) and Unicode case-insensitivity, can be cancelled (generation
  counter) and starts before the index is complete. Growth is handled incrementally (`large_refresh`); a shorter or
  replaced file is reopened. Limits: a match cannot span chunks; inside a line longer than 8 MB chunks overlap by
  64 KB. Measured on a ~200 MB log (warm cache): index ~40 ms, full search 40–90 ms.
  Editing, saving and the hot-exit journal are described below; measured on a 190 MB / 1.8 M line log (release
  build of the Rust core, warm cache): an edit plus fetching 50 lines ~80 µs, deleting a million lines ~20 µs,
  a journal backup with 2000 pieces ~3 ms, search in the edited document ~30 ms, save 120 ms; in the debug app via
  the e2e harness typing shows up in the DOM after ~3 ms (median), save 160 ms.
- **Editing large files (`pieces.rs`, `large.rs`):** the first edit (the index must be complete) puts a piece table
  over the file. The document is a list of pieces, each a byte range of the original (read positionally, never
  loaded) or of an append-only add buffer that holds all inserted text. An edit splits and replaces piece
  descriptors, so it costs the same in any file size. Every piece caches how many line breaks end inside it
  (the original's come from the viewer's line index, the add buffer's from a list kept while appending), and
  prefix sums over pieces make `line_start`/`line_of` binary searches; reading, line fetching and search go
  through the table once a file is edited. Undo records the descriptors an operation removed and inserted; both
  sources are immutable, so undo is the same splice backwards. Typing, backspace and delete in a row (within
  500 ms) are one step; the history is bounded (10 000 steps); undoing everything merges the pieces back into
  one, which makes the tab clean again. Positions are line and UTF-16 column of the decoded line, so the page
  never needs byte offsets; Rust converts (column clamped to the end of the line, lines of any length). Inserted
  text is encoded into the file's encoding and its dominant line ending (`encode_text`), so untouched bytes,
  invalid sequences and mixed line endings are saved exactly as they were. A file that ends with a line break
  has an empty last line, like in the editor, so the caret has a place after the final break.
- **Saving a large file:** `LargeFile::write_to` streams the pieces (8 MB chunks from the original, the add
  buffer for inserted text) into `.<name>.kladde-save` next to the target, `fsync`s it and swaps it in with
  `ReplaceFileW` like `write_safely`, but without its in-place fallback: the document is partly read from the
  very file that would be overwritten. The viewer then continues on the new file, with a line index derived
  from the piece table instead of a rescan, and the journal is removed after the swap. Save as writes a new
  file and leaves the original untouched. Before streaming, the original is checked against the fingerprint
  taken when editing began: if it was rewritten or became shorter, nothing is written (the edits describe
  bytes that are not there any more) and the journal keeps them; if it only grew (a logger that already had
  it open), the appended bytes are saved behind the document.
- **Protecting the original while it has unsaved edits:** the edits are offsets into the original, so it must
  not change. Growth is not followed while the document is modified, and Kladde holds a read handle that
  denies other programs write access (share mode read/delete: they can still read, rename and delete the file).
  If another program already has the file open for writing the handle cannot be taken; the save-time check
  above is the safety net then. The page only warns (banner) about changes on disk, it never reloads a dirty
  large tab.
- **Hot-exit journal for large tabs:** `backup/<tab>.large.json` holds the piece list (written atomically with
  `write_safely`), the original's size, mtime and the same head/tail fingerprint the viewer uses to detect
  rewrites, and the name of the add buffer file `backup/<tab>.<generation>.add`, which is appended to (it only
  grows) and `fsync`ed before the piece list that refers to it, so a crash in between leaves the previous,
  still valid journal. Disk I/O happens without the lock on the document, so typing never waits for a flush.
  The journal is written by `writeSession` for dirty large tabs (throttled like text backups, never debounced);
  `backup_prune` keeps it by tab id, as for `<id>.txt`. On restore the page asks Rust for every large tab,
  not only those with `hasBackup`: a crash between writing the journal and `session.json` leaves an older
  session file, and the journal must not be pruned unseen. `LargeFile::restore` applies it only if size, mtime
  and fingerprint match the file; otherwise the tab shows a banner (Apply anyway / Discard my changes), typing
  is refused until the user decides and the journal stays.
- **Local LanguageTool (`lt_install.rs`, `lt_server.rs`):** grammar checking works without any setup by downloading
  LanguageTool and a Java runtime on request (see decisions.md for why, the sources and the hashes).
  - *Layout:* `<data>/languagetool/<version>/` and `<data>/jre/<version>/`. A version folder counts as installed
    when `.kladde-complete` (written last, after the archive was unpacked and its main file found) and
    `languagetool-server.jar` / `bin/java.exe` exist; `.download.part` is the download in progress. The folder is
    extracted in place and not renamed from a temporary one: right after the extraction a virus scanner holds the new
    files and Windows refuses the rename ("access denied", seen in the first real run). A failed or cancelled install
    deletes the folder and the part file; a Kladde killed half way leaves a folder without the marker, which the next
    install deletes first. Installing the pinned version also deletes the folders of other versions. The Java
    runtime goes first, so a failing LanguageTool download does not repeat it.
  - *Download:* `ureq` (the stack of the LanguageTool client, Windows TLS), streamed to the part file while the
    SHA-256 is computed, checked before extraction (mismatch: file deleted, error kind `hash`), cancellable through a
    flag (`languagetool_local_cancel`, checked between 64 KB chunks; a stalled connection only ends at the 30 s
    response or 30 min body timeout). Progress goes through a Tauri `Channel` (`downloading`: bytes of both archives
    together, `extracting`: bytes), at most ten events a second; the status bar shows it and a click cancels. Errors
    carry a kind (`cancelled`, `network`, `hash`, `disk`, `other`) and a message that is shown as a notice; a full
    disk is explained. Extraction (`zip` crate with flate2/zlib-rs) skips entries that would leave the target
    (`enclosed_name`) and drops the archive's top-level folder.
  - *Routing:* `languagetool_check` decides per request (`lt_server::route`): a non-empty `languageToolServer` goes to
    that server, whatever else is installed; an empty one goes to the managed server if the local LanguageTool is
    installed, otherwise the request fails with a `config` error. The frontend sends the same request either way, the
    server address is just empty for the local one.
  - *Lifecycle:* nothing runs at start. The first routed request starts `java.exe -Xmx768m -cp languagetool-server.jar
    org.languagetool.server.HTTPServer --port <free port>` (working directory the LanguageTool folder, no console
    window through `CREATE_NO_WINDOW`; the server binds the loopback interface only, which is its default, `--public`
    is never passed) and waits until `GET /v2/languages` answers (up to 120 s). Concurrent requests wait for the same
    start. A bind error on the chosen port (someone took it meanwhile) is retried with another port, up to three times.
    The child lives in a Windows **job object with `KILL_ON_JOB_CLOSE`**: when Kladde ends, is killed or crashes, the OS
    closes the handle and kills the server, so no Java process is left behind (the e2e test kills Kladde and checks).
    A monitor thread stops the server after 15 minutes without a request (`IDLE_TIMEOUT`; every request touches the
    timer before and after) and notices when it dies. `languagetool_local_stop` stops it when checking is turned off,
    when a server of the user's own is set, and (in Rust) before an install or removal, because the folders are in use.
    The frontend follows through the `languagetool-state` event (`starting`, `running`, `stopped`): the status bar says
    "Grammar: starting LanguageTool…" while a check waits for the start, and the request simply resolves afterwards,
    so no error shows in between. A request that fails because the server died says so ("exited (exit code N): <last
    output>. It starts again with the next check") and the next request restarts it; a start that fails (Java
    missing, an error at start) reports the exit code and the last lines of its output once, and the frontend's
    backoff retries. A request that outlives a stop (error kind `stopped`) is no failure.
  - *Heap and measurements* (real LanguageTool 6.8 and Temurin 21.0.13 on a Windows 11 development machine, text of
    English and German with many errors): `-Xmx768m`. (Heap limits were tried with 6.6; the real run with 6.8 gave the same picture.) At 384 MB a request of 15 000 German characters (the request
    limit) fails with HTTP 500; 512 MB works but is close to the edge (up to 27 s with `SerialGC`, 6–10 s with G1);
    768 MB takes 6–10 s for that worst case and 1–4 s for a normal paragraph. Working set of the Java process:
    ~250 MB right after the start (1.2–1.4 s until it answers), ~600 MB after the first English check (2 s), ~935 MB
    after English and German (the first German check ~4 s, 0.9 s once loaded). Download 49 MB + 259 MB, 566 MB on
    disk (152 MB runtime, 414 MB LanguageTool); the whole install takes ~30–60 s on a fast line.
  - *Test overrides* (isolated profile only, like `KLADDE_UPDATE_URL`): `KLADDE_LT_DOWNLOADS` (URLs, hashes and sizes
    of the two archives), `KLADDE_LT_COMMAND` (another program instead of Java; Kladde appends `--port <n>`),
    `KLADDE_LT_IDLE_SECS`. See [testing.md](testing.md).
- **Isolated profile:** `KLADDE_DATA_DIR` replaces the data and config folders, disables the single-instance plugin
  (so a test instance can run next to the normal one), switches registry writes to a test key and keeps the updater
  away from the real server. See [testing.md](testing.md).

## Frontend (`src/`)

| File | Responsibility |
|---|---|
| `App.svelte` | Layout, the command list (`registerActions`), window events (focus, close, drag and drop, single-instance hand-off), effects for fonts/theme/settings |
| `lib/workspace.svelte.ts` | The heart: tabs, open/save/close/reload, encodings, external changes, preview rendering, compare tabs, formatting, large-file glue, session (hot exit) |
| `lib/editor.ts` | CodeMirror extensions and compartments (language, wrap, indentation, gutters, active line, spelling, grammar, read-only), theme, search-panel phrases, keymap filtering |
| `lib/actions.ts`, `keys.ts`, `keymaps.ts`, `editor-actions.ts`, `shortcut-editor.svelte.ts`, `keyhint.svelte.ts` | Commands and keyboard handling (see below) |
| `lib/languages.ts` | ~145 languages from `@codemirror/language-data` plus own Batch and Log stream parsers; detection by extension, file name, shebang, first line |
| `lib/markdown.ts`, `math.ts`, `mermaid.ts` | Preview: markdown-it → DOMPurify; KaTeX rules; Mermaid placeholders drawn after insertion |
| `lib/native-menu.ts` | Which right clicks may show WebView2's native menu (editable text only) and the selected text for our own Copy menu |
| `lib/links.ts`, `lib/editor-links.ts` | Links: finding them in a line, what an href means, heading anchors and path helpers (pure, unit-tested); the editor extension for Ctrl+click and the hover hint (see "Links") |
| `lib/format.ts`, `format-xml.ts`, `formatters.ts` | Own JSON and XML formatters; dispatch by language to lazily loaded Prettier and sql-formatter |
| `lib/compare.ts` | Merge views for compare tabs (`@codemirror/merge`, custom diff for ignore whitespace/case) |
| `lib/grammar.ts`, `grammar-text.ts` | LanguageTool: lint integration (lazy) and the pure text side (Markdown masking via LanguageTool's `data` format, paragraphs, request budget, offset mapping) |
| `lib/languagetool-local.svelte.ts`, `components/LocalLanguageTool.svelte` | The local LanguageTool in the UI: install state, download progress, server state (event from Rust); the block in the settings page's "Spelling and grammar" section |
| `lib/theme.ts`, `src/themes.css`, `src/app.css` | Flavors, accents, role variables, user `theme.css` |
| `lib/integration.svelte.ts`, `components/DefaultEditor.svelte` | Default-editor offer and Explorer integration UI |
| `lib/updates.svelte.ts`, `components/UpdateBanner.svelte` | Update check banner |
| `lib/linehighlight.ts` | Highlights visible lines of the large viewer with the editor grammars (`tok-*` classes) |
| `components/LargeFileView.svelte` | The large file view: visible lines fetched from Rust, hand-drawn scrollbar, caret/selection as line/column pairs, a hidden `<textarea>` that receives typing, IME and paste at the caret, a queue (`enqueue`) that runs keys and edits one after another so positions are never stale, search toolbar |
| `lib/large-edit.ts` | Pure helpers of the large file view (caret movement over one line's text, words, spans for selection/caret, the editor commands it supports); unit-tested |
| `lib/settings-schema.ts`, `lib/settings.svelte.ts` | The `Settings` type, its defaults and the metadata of every setting (plain TypeScript, so unit tests can load it); the reactive store, `loadSettings` (only accepts keys whose type matches the default) and `updateSettingsFile` |
| `components/SettingsPage.svelte`, `lib/config-files.ts` | The settings page (a tab, loaded on first use); reading and writing the JSON files of the config folder, shared with the shortcut editor |
| `components/DocumentView.svelte` | The viewer of document tabs (loaded on first use, kept alive while hidden): reads, renders with docx-preview, cleans, shows in a sandboxed `srcdoc` frame with a CSP of its own; the bridges for keys, wheel, theme, focus, scroll, zoom, links, selection, errors (see "Document tabs") |
| `lib/documents.ts`, `lib/css-scan.ts`, `lib/document-clean.ts` | The document viewer's logic: extensions, container signatures, error texts, zoom and fit, the frame's policy, sandbox, starting document and event copies (pure, unit-tested); the CSS tokenizer that finds addresses in declaration values (pure, unit-tested); the cleaning of rendered nodes (DOM, tested in the app) |
| `lib/api.ts` | Typed wrappers of all Tauri commands |

### Tabs and the editor

- Tab kinds: `text`, `large` (the document lives in Rust), `image`, `document` (a read-only view of a file by path, see
  "Document tabs"), `compare`, `settings`. Tab metadata lives in Svelte `$state` (`workspace.tabs`); editor
  state does not. The kind names are part of the session file (`session.json` stores `kind` per tab, a public format):
  never rename one, and give a new kind a restore path in `restoreTab` (an older Kladde that reads a session with an
  unknown kind opens the file as text).
- **One shared `EditorView`** for all text tabs. Inactive tabs keep their `EditorState` (with undo history) in the
  non-reactive `runtime` map; `activate()` swaps states with `view.setState` and restores the scroll position.
  View-wide options (wrap, indentation, gutters, spelling) are reapplied after a swap (`applyViewOptions`).
- Dirty tracking compares the document with the saved `Text` (`rt.saved`), plus `metaDirty` for encoding or
  line-ending changes that need saving although the text is unchanged.
- **Saving writes only what changed.** `save()` of a tab whose text equals `rt.saved` and without `metaDirty`
  writes nothing and succeeds (`unchanged`), so Ctrl+S on an untouched file keeps its bytes: mixed line endings,
  a .docx, anything the editor cannot round-trip. Exceptions: the file is gone from the disk (checked with
  `stat`; saving recreates it; large tabs likewise), and Save As, which always writes (`writeText(tab, true)`).
  Callers: Save all and the close prompt only reach `save` for dirty tabs; Save (Ctrl+S, `file.save`) calls it for any
  tab, which is why a clean tab must write nothing (it still calls `onConfigSaved`, so saving an unchanged
  settings, keybindings or theme file applies it). A failed or cancelled save keeps the tab open and dirty.
  A file that vanished sets `rt.gone` (dirty, so hot exit keeps the text, but not `metaDirty`): it clears when the file
  comes back with the same modification time, and a tab with `gone` is never "unchanged".
- **Files that are not text:** a tab with `binary` or `lossy` is read-only (`workspace.isReadOnly`: flags and not
  `tab.unlocked`) in text tabs (the `readOnly` compartment, `EditorState.readOnly`: CodeMirror's commands, typing,
  paste, drop and the search panel's replace refuse; `format` and the image paste check it themselves) and in the large
  view (`editable()`). `App.svelte` shows the banner with **Edit anyway** (`workspace.editAnyway`), which sets
  `unlocked`. The first write of such a tab (Save, Save as, or a dirty large tab) asks once through `ask`
  (`confirmNonTextWrite`, remembered in `rt.bytesConfirmed`; Cancel is the default button and keeps the tab dirty).
  Changing encoding or line ending of a read-only tab is refused. A reload (external change, F5) keeps `unlocked`
  while the file stays binary or lossy. On restore, a tab with edits (dirty after the backup was applied, or a large
  journal) comes back unlocked so the user can save them, an unedited one read-only (a discarded journal locks it
  again); a vanished file keeps its `binary`/`lossy` from the session (optional fields). `unlocked` is only ever set
  for a tab that is binary or lossy (so a restored text tab that later turns lossy is read-only). Read-only tabs are
  not grammar checked (`grammarEligible`) and a grammar fix refuses to edit a read-only view.
- `workspace.openPath(path, { asText: true })` opens a file in a text tab although its type would route it elsewhere
  (images today; a viewer for other types, offering "Open as text", later). It ignores a viewer tab that already
  shows the path (a text or large tab of the path is activated instead), and size still picks the large viewer.
- A reload is applied as the minimal change (`minimalChange`), as an undoable edit, so the cursor stays and
  following a log is cheap.
- Opening a file into an untouched empty "new N" tab replaces it (Notepad++ behaviour). Images open in an image tab and
  `.docx` files in a document tab (both by extension, before the size check); `openPath(path, { asText: true })`
  skips that routing and opens the file as text; files above `largeFileThresholdMB` (32) in the large viewer; "Open in editor…" loads large files up to 256 MB.
- Tab history (`Alt+Left`/`Alt+Right`, mouse back/forward) is a browser-like stack of activated tabs, not
  persisted.

### Session and hot exit (zero data loss)

- Closing the window never asks: `onCloseRequested` awaits `saveSession()`. Closing a single dirty tab does ask.
- `scheduleSession()` is a **throttle**, not a debounce: the first change arms a timer (300 ms plus size/500 ms,
  at most 3 s), later changes do not push it back, so continuous typing is backed up. Focus loss saves immediately.
- `writeSession()` snapshots each tab's state and version together before awaiting writes, so edits made during a
  write are not marked as backed up. Writes are serialized through `sessionChain`.
- **Write order: the session never lags behind the backups.** The restore only looks for the backups of the tabs
  `session.json` lists, and the pruning after a save deletes every backup it does not list, so a backup written
  before the session that names it is lost by a crash in between (issue #15: a new tab's text was on disk, the
  restart showed fewer tabs). `writeSession()` therefore does: (1) `session.json` naming every tab whose backup is
  about to be written (`hasBackup: true`), (2) the backups whose text changed, (3) `session.json` again unless it
  is the same JSON as in step 1, (4) the pruning. `Workspace.backupListed` mirrors what the session on disk lists;
  step 1 only happens when a text tab needs a backup that it does not list yet (a tab turning dirty, a new
  untitled tab with text). Typing in a tab that is already listed writes the backup and one session, exactly as
  before, and a save with a new tab is still one session write, because step 3 is skipped (the snapshot is the
  same). A backup is only marked as written (`rt.backedUp = version`) after it was, and one that fails (disk full)
  tells the user and is retried with the next change; the session then names a backup that is missing or
  older, which the restore copes with.
- **Restore after a crash between the writes:** a tab the session lists with `hasBackup` that has no backup
  file (nor an older version) opens from the file on disk, not dirty, without an error (the text of the last few hundred
  milliseconds never reached the disk, which no order of writes can change); an untitled tab with a missing
  backup is skipped; an older backup is restored as it is (dirty). Large tabs keep their journal order (journal,
  then session): journals are asked for on restore whatever the session says, so the first session of a save does
  not claim a journal that is not written yet (the restore would report the changes as lost).
- Data folder layout: `session.json` (tab list, active tab, wrap, spell check, zoom, per-tab language/encoding/eol/
  preview/cursor/scroll, `hasBackup`, optional `binary`/`lossy` for a file that is gone), `backup/<id>.txt` (current text of dirty or untitled tabs) and
  `backup/<id>.<n>.txt` (up to 5 older versions, at least 5 minutes apart; a new version is a copy of
  `<id>.txt`, so the current backup never leaves its place, and restore falls back to the newest version if
  `<id>.txt` is missing), plus marker files
  (`no-default-editor-offer`, `last-update-check`) and the downloaded local LanguageTool (`languagetool/`, `jre/`). Config folder: `settings.json`, `keybindings.json`, `theme.css`.
- Restore reads disk + backup: a tab with a backup is dirty if it differs from disk; a vanished file stays as a
  dirty tab marked "deleted". Compare tabs are snapshots and are not restored.
- External changes are checked on window focus and every 2 s for the active tab while focused: unmodified text tabs
  reload silently, dirty ones get a banner (Reload / Compare / Keep my version), large tabs follow growth. A dirty
  large tab is never followed or reloaded silently (see "Editing large files"): the banner offers Reload (which
  asks first) and Keep my version.

### Commands and keys

- Every command is an action `{ id, label, keys, run, enabled }`; ids are public (keybindings.json, presets).
- A window-level capture handler (`handleKeydown`) runs before CodeMirror. Editor commands (`editor.*`, plus
  `edit.deleteLine`) are actions too, and `editor.ts` removes their stock CodeMirror bindings, so every key has
  exactly one owner and unbinding frees it. Typing keys stay in CodeMirror.
- Resolution order: action default keys → preset (`keymaps.ts`, only differences, `[]` unbinds) → keybindings.json;
  a higher layer takes a key away from a lower one. Chords (`Ctrl+K Ctrl+C`) wait ~2 s with a status-bar hint.
- The large file view handles its own caret keys, `Ctrl+Z`/`Ctrl+Y`/`Ctrl+Shift+Z`, `Ctrl+A`/`C`/`X`/`V` and typing
  in a textarea (those are CodeMirror's stock bindings in text tabs, not actions, so there is still one owner per
  key). The editor commands listed in `LARGE_COMMANDS` (`large-edit.ts`: delete/cut/duplicate/move/blank line,
  select line, upper/lower case, find) keep their ids and keys: `App.svelte` wraps the actions so that they run
  in the large view (`workspace.largeApi.run`) when a large tab is active. Other editor commands are disabled there.
- Browser accelerators of WebView2 (F5 reload, Ctrl+P print, Ctrl+J, Ctrl+U, F7 caret browsing, find bar) are
  swallowed in `onKeydown`; the WebView's own zoom is replaced by Kladde's font-size zoom (Ctrl+wheel/Plus/Minus).

### Settings page

- Kind `settings`: one tab (`workspace.showSettings()`, command `settings.show`, `Ctrl+Alt+S`) shown by `SettingsPage.svelte`. A
  tab fits better than a panel: Kladde has no side areas, a tab is reachable with the existing tab keys and mouse
  gestures, it can sit next to `settings.json` or `theme.css` while one edits them, and it needs no new layout
  state. Like a compare tab it is kept alive while hidden (search text and scroll position stay), is not saved in
  the session (nothing to restore) and is never dirty. The component is a dynamic import in `App.svelte` (about
  6 kB), so nothing is loaded until the first `Ctrl+Alt+S`. `Escape` clears the search, then returns to the previous tab
  (`leaveSettings`); the search box gets the focus whenever the tab is shown.
- `SETTING_META` in `settings-schema.ts` is a `Record<keyof Settings, …>`: group, label, description and control
  (`boolean`, `number` with min/max, `choice`, `text`) of every setting, next to `defaultSettings`. A setting without an
  entry does not compile, and `tests/unit/settings.test.mjs` checks that controls fit the defaults. Choices come from
  the same lists the app validates with (`theme.ts`, `keymaps.ts`, `grammar-text.ts`). The page, the search
  (`settingMatches`) and the value check (`coerceSetting`) are all driven by it.
- Writing: `updateSettingsFile` reads settings.json as an object (a file that is not valid JSON is never overwritten),
  changes the entries, writes it with `write_safely` like the shortcut editor does and calls `loadSettings`, so the page
  and the whole UI update at once. A value equal to the default **removes** the entry (same rule as `setEntry` in the
  shortcut editor), which is also what "Reset to default" does; unknown entries and the user's other values stay.
  Writes are serialized. A value of the wrong type or an unknown flavor in the file is replaced by the default when
  loading, so the page always shows a valid state (and says why under the search box). `wordWrap`, `spellCheck` and
  `grammarCheck` are start-up values while the session keeps the current ones, so the page also applies them to the
  current session (`workspace.followSetting`).
- Edits of settings.json in a tab take the old path (`reloadConfig` → `loadSettings`) and the page, which only reads
  the reactive `settings`, follows.

### Preview

- markdown-it (`html: true`, linkify) with own rules: `data-line` on blocks (scroll sync from the editor), heading
  ids, task-list checkboxes, highlighted fences using the editor grammars (`highlightCode` + `classHighlighter`).
- Output is sanitized with DOMPurify (`FORBID_TAGS` in `markdown.ts`: no `form`, `input`, `button`, `select`, `textarea`,
  `style`, `iframe`, `meta`, … and no `formaction`); local image `src` are rewritten to the asset protocol
  (`convertFileSrc`). Task list checkboxes are therefore not `<input>`s but `<span class="task-box" role="checkbox"
  aria-checked>` drawn by the preview's CSS.
  Links go through `workspace.openHref` like those of the editor (see "Links").
- Mermaid: fences become placeholders; `renderDiagrams` draws them after insertion (`securityLevel: "strict"`),
  caches SVGs by source and theme, keeps the stale SVG while re-rendering, shows errors inline.
- Math: own markdown-it rules (`$…$`, `$$…$$`, ```` ```math ````) rendered by KaTeX once its chunk is loaded;
  `$5 and $10` stays text. A re-render is triggered when a lazy dependency finishes loading.
- SVG files get an image preview; pasting an image into a saved Markdown file writes it to `pasteImageFolder`.

### Links

- One function decides what a link does: `workspace.openHref(href, { baseDir, anchor })`, used by the preview (a click
  on an `<a>`) and by the editor. `classifyHref` (`links.ts`) maps the href to a browser URL (http, https, mailto;
  opened with the opener plugin's `openUrl`), a heading of the same document (`#id`; the preview scrolls, the editor
  moves the cursor), a file (relative to the folder of the file, `?query`/`#fragment` dropped, `%XX` decoded, opened in
  Kladde as text; nothing for an untitled file) or nothing. Everything else is rejected: other schemes (`file:`,
  `javascript:`, custom ones), network (UNC) paths, paths with a colon. Nothing is ever executed.
- Heading ids come from one slug rule (`createSlugger` in `links.ts`, used by `markdown.ts` for the preview's ids and
  by `headingAnchors` for the editor, which numbers repeated titles the same way). `headingAnchors` scans the lines
  of the document, only on a click on an `#anchor`.
- Finding links (`linkAt`): bare `http(s)://` and `mailto:` URLs in every file type, with trailing punctuation and
  unbalanced `)`, `]`, `}` cut off; in Markdown also `[text](target)` and `![alt](target)` (balanced parentheses,
  `<…>` targets with spaces, titles, nesting such as badges: the text opens the outer link, an inner target its own).
  Only the line under the pointer or cursor is searched, and only around it (±10 000 characters) on very long lines.
  `[a](b)` inside Markdown code (span, fence, indented block) is not a link; a URL there still is.
- `editor-links.ts` is a `ViewPlugin` in `editorExtras`. Its `mousedown` handler runs before CodeMirror's own (plugin
  handlers come first), so a Ctrl+click on a link opens it and returns `true`: CodeMirror then neither adds a cursor
  (`clickAddsSelectionRange`, Ctrl on Windows) nor moves the selection. Anywhere else the event falls through and
  multi-cursor works as before; plain clicks and double-clicks are never touched. Hover: `mousemove` with Ctrl held (and
  a Ctrl key press over a still mouse) finds the link at the position and shows it as one mark decoration
  (`cm-link-hover`: underline, pointer), held by the plugin so it never outlives a tab switch. Releasing Ctrl, leaving
  the editor, the window losing focus and edits remove it. Without Ctrl the handlers only remember the mouse
  position; there is no per-keystroke work and no document-wide decoration pass. The pointer must really be over
  the link's characters (checked with `coordsAtPos`), not just at the nearest position.
- "Open link at cursor" (`edit.openLink`, no default key) does the same for the main cursor; it says so when there
  is no link. The large file view and compare tabs have no link handling.
- Test hook: with an isolated profile, `KLADDE_OPEN_URL_LOG=<file>` makes the `open_url_hook` command append every
  external URL to the file and report it handled, so the browser is not started ([testing.md](testing.md)).

### Compare tabs

- Kind `compare`: two text snapshots in `workspace.compareData`, shown by `Compare.svelte` (kept alive while hidden,
  so it keeps its scroll position) through `compare.ts`. Ignore whitespace/case use a custom diff function passed to
  `@codemirror/merge`. Not part of the session.

### Document tabs

Kind `document` is a generic read-only view of a file by path (like `image`, but with a viewer of its own): Word
documents (`.docx`) now, and a later PDF viewer would add its extension to `lib/documents.ts` and its engine to
`DocumentView.svelte`. The tab holds only metadata (path, size, mtime); the session stores it by path like an image
tab, plus the scroll position, and restores it without rendering: a restored tab renders on its first visit, so
nothing is read or loaded at startup.

- **Routing:** `openPath` sends `.docx` to a document tab before the large file check (the viewer has its own limit).
  The file is read by `read_document` (`files::read_limited`): the raw bytes as a binary IPC response (an
  `ArrayBuffer`, no JSON number array), refused above 50 MB. Above the limit, or when the file is encrypted (the OLE
  compound signature `D0 CF 11 E0`: Word's rights-managed and password-protected files, also old `.doc`), not a ZIP,
  or damaged, the tab shows a message with **Open in default app** and **Open as text** (also the command
  `document.openAsText`, "Open as text"). Opening in the default app is a Rust command (`open_in_default_app`, the
  opener plugin) that only starts files of the types the viewer shows, so the page needs no opener scope for paths.
- **Engine:** docx-preview 0.4.1 (exact version) on JSZip, both loaded with the viewer on first use (a ~170 kB chunk,
  ~49 kB gzip, next to the viewer's own ~10 kB). It was chosen over mammoth in the spike (decisions.md). The viewer calls
  `parseAsync` and `renderDocument`, which return **detached nodes made by the frame's document** (the option `h`, see
  "Untrusted documents"), built element by element (no HTML parsing),
  `renderAltChunks: false` (raw HTML inside a file is never shown), `useBase64URL: true` (images and fonts become `data:`
  URLs, which the CSP allows; `blob:` is not needed and not in the CSP).
- **Tracked changes and comments are shown, not hidden** (`renderChanges: true`, `renderComments: true`): the engine's
  default would show insertions as plain text and drop deletions and comments, a text that is not what the file says.
  Insertions are underlined and deletions struck through, both in marker colors (`--paper-insert`, `--paper-delete`),
  and a comment is a marker with its text on hover. Nothing is accepted or rejected; the view is "all markup".
- **Untrusted documents: the frame is the barrier.** A document is rendered into a `srcdoc` iframe whose own document
  carries `<meta http-equiv="Content-Security-Policy">` as the first thing in it (`FRAME_CSP` in `documents.ts`:
  `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`).
  Scripts, frames, objects, media, `<link>`, `fetch`, the ping of a link, `@import` and `@font-face` fall under
  `default-src 'none'`; images and fonts may only be `data:` (the engine inlines both); inline styles are what the
  engine writes. A `srcdoc` frame also inherits the page's policy, so both apply and the stricter one wins for every
  request. "A document cannot make a network request" therefore holds by construction, whatever CSS, SVG or HTML a
  future engine version or a crafted file produces: it no longer depends on knowing every way to name an address. The
  page's own CSP still allows https images (the Markdown preview shows remote ones), which is why the document is not
  attached to the page: a shadow root cannot have a policy of its own.
  - **Sandbox:** `sandbox="allow-same-origin"` (`FRAME_SANDBOX`, set before `srcdoc`, which a test pins). The frame keeps
    the page's origin, which the page needs to drive it (listeners on its window and document, its selection and scroll
    position, all through plain JavaScript on `contentWindow`). Nothing else is granted: no scripts (the policy says so
    too), no top navigation, no forms, no popups, no downloads, no modals, no pointer lock. `allow-same-origin` without
    `allow-scripts` is safe here because nothing in the frame can run: the combination is only dangerous when the framed
    document can remove its own sandbox. The listeners the page registers on the frame's window and document fire as
    on any page (click, keydown, wheel, contextmenu, scroll, selection).
  - **The frame never navigates.** Sandbox flags do not stop a frame from navigating itself (`<meta http-equiv=refresh>`,
    a link's default action, `location`), and `on_navigation` only sees the top-level frame. `create_main_window`
    registers a `FrameNavigationStarting` handler (WebView2 COM, the same style as the unparseable-URL guard) that cancels
    every frame navigation except `about:srcdoc` (`navigation::cancels_frame_navigation`, unit-tested). Kladde has no
    other frames (the Markdown sanitizer drops `iframe`, Mermaid draws inline SVG), so nothing else needs to pass. The
    page cancels link clicks itself (see "Focus and keys"); the guard and the page's policy (`frame-src` falls back to
    `default-src 'self'`) are the layers behind that. The test points the frame at `about:blank` and at the app's own
    origin (neither is refused by the policies) and adds a `<meta>` refresh: the frame must stay the same document, and
    the guard logs the cancellations.
  - **The nodes are born in the frame.** The engine's default `h` creates every element with the page's global `document`,
    and an element can start loading the moment an attribute is set (`<img src>`, SVG `<image href>`, media), even
    detached, under the *page's* policy, which allows https images. The engine reads `options.h`, so the viewer passes
    `makeH(frameDocument)` (`documents.ts`, a mirror of the default: text, `#fragment`, `#comment`, `ns`, `className`,
    `style` as text or object, other keys as properties, children through the same function; already made nodes pass
    through, recognized by `nodeType` because a frame's nodes are not instances of the page's `Node`). The frame has to
    be loaded before a render. Nothing else in the engine's render path makes nodes with the page's document: its other
    `document.` uses are tab stops (`experimental`, off), a text node in `renderElements` (text cannot load anything),
    and the XML parsing of the file's parts (`DOMParser`, `application/xml`, which loads nothing). The e2e test counts
    the nodes the page's and the frame's `Document` make during a render: none by the page's. The cleaner (below) works
    on frame nodes, so it tests `nodeType` and not `instanceof Element`.
  - **The cleaner stays as the second layer** (`cleanDocumentNodes`, `css-scan.ts`; it also keeps the DOM small): before
    the nodes are attached to the frame's tree every `<style>` is parsed into a constructable `CSSStyleSheet` (`@import` ignored), its rules are walked
    (CSSOM), `@import` and `@property` rules are dropped and every declaration whose value refers to something other
    than a `data:` address is removed (a tokenizer, not a regular expression, so CSS escapes such as `u\72l(` and
    comments cannot hide an address); the same for `style` attributes and every attribute of every element (the engine
    copies VML colors unchanged into SVG `fill` and `stroke`). Scripts, frames, objects, links, forms and media
    elements, event handler attributes and every address attribute that is not a link's `href` go too. `:host` rules are
    dropped as before, although the frame has no host. The guarantee does not rest on the cleaner any more.
  - **Test hook:** with an isolated profile and `KLADDE_DOCUMENT_NO_CLEAN=1`, the viewer skips the cleaner
    (`document_no_clean` in `lib.rs`, one cached call per run; `no_clean_for` is unit-tested to need the isolated
    profile, so a stray variable can never switch the cleaner off in a normal installation). The e2e test renders a
    document that tries every known way out (testing.md) that way and listens for any connection.
  - What the checks cover (`document.test.mjs`): with the cleaner on, the per-way listeners (font-name injection,
    `image-set(var())` through a font name and a VML style, VML fill and stroke, a linked picture) and the computed
    styles; with it off, fourteen CSS ways (`url()`, `image-set()` also through `var()`, `border-image`,
    `list-style-image`, `cursor`, `mask`, `filter`, `clip-path`, `shape-outside`, `content`, `@font-face`, two kinds of
    `@import`), SVG paint attributes and a linked SVG `<image>`, a linked `<img>`, and 22 kinds of element put into the
    live frame (`img`, `srcset`, `picture`, three `link`s, nested frames, `object`, `embed`, `video`/`audio` with a poster,
    SVG `image`/`use`/`fill`, `input type=image`, `table background`, a `style` attribute and element, `a ping`, a form
    submission and a `<meta>` refresh). A control frame without a policy of its own gets the same material and does
    fetch it, so the listeners can see a leak. The test was also run once with `img-src https: http:` added to the
    frame's policy, and fails with the listeners it names (checked by hand, not kept).
  - **Known gap: a nested frame opens a connection.** Found by that test: WebView2 opens a TCP connection when a frame
    starts to navigate, before any policy check (the frame's, and the page's own, were both tried, also `frame-src
    'none'`) and before the frame guard cancels the navigation. No HTTP request is sent (a plain HTTP listener saw only the
    connection), but for `https:` the connection starts a TLS handshake that names the host. Nothing a document can do
    makes the engine emit a frame (`renderAltChunks: false`), and the cleaner removes every `iframe`, `frame`, `object`
    and `embed`, so this is a fallback that is weaker than for images; the test lists it as tolerated and asserts that the
    guard cancelled the navigation.
- **Layout and zoom:** pages have the document's own size (A4 is 794 px). They are shown at their size, or shrunk to the
  width of the window (fit to width, never enlarged); Kladde's zoom (keys, `Ctrl`+wheel, the same `ui.zoom` as the font
  size) scales them on top, by the same proportion as the font size. Done with the CSS `zoom` of the host element inside
  the frame; the scroll position scales with it (`overflow-anchor: none`, set by hand). The pages' width is measured
  when the frame has a layout: a render that finishes while another tab is shown (a reload, or the first render of a
  background tab) has none, every width reads 0, so scale, zoom and place stay as they were and the measurement waits
  for the tab to be shown again (the frame window's `resize` and a `ResizeObserver` on the frame element say so). The
  place is kept in px at scale 1 across a measurement, so it is not scaled twice, and the scroll events of a frame
  that comes back from `display: none` do not overwrite it while it is put back (`settling`).
- **The frame scrolls itself.** The iframe fills the pane and its own document is the scroller (desk background
  `--bg-alt`, the app's scrollbar style, pages centered, horizontal scroll when wider), instead of a frame as tall as its
  content inside a scroll pane of the page. Why: keyboard scrolling (arrows, PageUp/PageDown, Home/End, Space) is the
  browser's own and works with the focus in the document without any forwarding, nothing has to measure the
  document's height across the boundary (a reload would have to resize the frame), and the frame clips whatever the
  document positions (`position: fixed` or absolute shapes, which used to need `contain: paint` on the stage) to its box.
  `data-removed` and `data-scale`, the hooks the tests read, are on the iframe element.
- **Theme:** the overrides use the app's variables (`--paper`, `--paper-text`, `--paper-insert`, `--paper-delete`, and
  `--bg-alt`, `--fg-dim` for the desk and scrollbars). Custom properties do not inherit into an iframe, so the viewer
  copies their computed values onto the frame's root element (`FRAME_VARIABLES`, `syncTheme`) when the frame loads and on
  every `kladde-theme` event, which `applyTheme` (flavor, accent, system mode) and `setUserTheme` (a live-edited
  `theme.css`) dispatch. The host's font defaults (Calibri, Carlito, Segoe UI, 11 pt) are the frame's own CSS.
- **Focus and keys:** the viewer takes the focus (the iframe element and its window) when its tab becomes active, after a
  palette or dialog closed (`workspace.registerDocument`, `refocusDocument`, called by the palette, the dialogs, the
  Windows registration dialog and the key capture dialog) and after an error is shown, never while one of them is open,
  so PageDown and the arrows scroll without a click. Events do not leave a frame, so the page's window listeners
  (`App.svelte`: shortcuts, zoom, mouse buttons) never see what happens inside it. The viewer bridges them from the
  frame's window by dispatching a **copy of the event on the iframe element** in the page (`forward`, with
  `keyboardInit`/`wheelInit`/`mouseInit` carrying the fields over and moving pointer coordinates by the frame's box):
  the same capture handlers run as for any other target, including their "not while a dialog is open" rule, and when one
  of them cancels the copy the original is cancelled too. Forwarded: every `keydown` (shortcuts such as Ctrl+W,
  Ctrl+Tab, Ctrl+Shift+P, Ctrl+S, F5, the zoom keys), `Ctrl`+wheel (zoom; the pointer may be over the document) and the
  mouse's back and forward buttons. Plain wheel and keys the page does not handle are the frame's own (scrolling).
  `Ctrl+A` selects the document only (the pages, not the desk; handled in the frame after the page declined the key);
  `Ctrl+C` is the native copy of the frame's selection. Links are found from the click's target with `closest("a")`
  (the frame's elements belong to another realm, so no `instanceof`), the click is always cancelled, and it goes
  through `workspace.openHref` with the file's folder as `baseDir` (http, https, mailto; `#bookmarks` scroll the
  frame). The page's context menu handler never sees an event of the frame, which has its own: the native menu is
  always cancelled, an own menu with *Copy* shows only while text is selected, at the pointer's place in the window (the
  frame's coordinates plus the frame's box); a pointer press inside the frame closes it (the menu's own close on
  `pointerdown` does not see it).
- **Comments:** the engine registers the ranges of comments in `CSS.highlights` under `docx-comments`, on the page's
  global. They belong in the frame, where their nodes are: the viewer takes the highlight out of the page's registry right
  after rendering (in a queue, so two document tabs rendering at once cannot take each other's) and registers it in the
  frame window's registry; the registries are cleared on destroy and the frame goes with the tab. (The engine ships no
  `::highlight()` style, so nothing is painted today; the registry entry is what is kept equal to before.)
- **Scroll position** is kept in the tab's runtime entry (`setDocumentScroll`), so it survives tab switches (the viewer is
  kept alive while hidden, so a document is not rendered again on every visit; a hidden tab has no layout, hence the
  explicit save and restore), reloads and the session.
- **Reloading:** `checkExternalChanges` notices a new mtime (the active tab every two seconds while the window has
  the focus, every tab when it gets the focus) and bumps `tab.revision`; F5 does too. The viewer waits 300 ms, reads again and
  swaps the new nodes in at once, so the old rendering stays until the new one is complete. A file that is being saved
  (Word writes in steps or replaces the file: a sharing violation, a missing file, a truncated ZIP) is read again after
  0.3, 0.6, 1.2 and 2.4 s with the old rendering still shown; only then an error appears. On the first read only a
  sharing violation is retried.
- **Status bar:** "Word document (read-only)", the page count and the size. The page count is the file's own
  (`docProps/app.xml`, `Pages`, which Word writes on save; `pageCountOf` accepts a whole number from 1 to 100000);
  without one, none is shown. The number of rendered `section.docx` boxes is not a page count: the viewer breaks pages only
  at explicit page breaks and sections (`ignoreLastRenderedPageBreak`), so a long text without them is one tall box.
- Not part of it: finding text in a document, printing, `.doc`, `.docm`, `.dotx`, `.odt`, registering Kladde as a `.docx`
  handler.

### Theming

- `src/themes.css` holds the four Catppuccin flavors (official palette), the 14 accents and the role variables built
  from them (`--bg`, `--fg`, `--accent`, `--tok-*`, `--diff-*`, `--lt-*`, …). `theme.ts` resolves the flavor
  (`theme`, `themeLight`/`themeDark` for `system`, `accent`), sets `data-theme`/`data-accent` on the root, sets the
  native title bar light/dark and loads the user's `theme.css` last (before the window is shown, so there is no
  flash).
- Flavor and accent selectors use `:where()`, so a plain `:root { … }` in `theme.css` overrides them. Keep it.
- Latte is the only light flavor (`isLight`). `--accent-fg` must stay readable (4.5:1) on every flavor/accent
  combination — `tests/e2e/theme.test.mjs` checks all 56.
- New colored UI needs a role variable in `themes.css`, an entry in `THEME_VARIABLES` (it generates the `theme.css`
  template) and a row in the README theming table. Mermaid reads the variables and redraws on the `kladde-theme`
  event.

### Windows integration and updates

- `integration.rs` writes, per user and under a registry root passed in: ProgID `Kladde.Document`,
  `Software\Kladde\Capabilities` (file associations per group), `RegisteredApplications`, `OpenWithProgids` per
  extension and for `*`, and optionally the "Edit with Kladde" context menu. Then it notifies the shell and opens
  `ms-settings:defaultapps?registeredAppUser=Kladde`. A registration with another exe path is refreshed silently at
  start. `--unregister-integration` (run by the NSIS uninstaller, not during updates) removes everything; the
  dismissal of the start-up offer is a marker file, not a setting.
- `update.rs` wraps tauri-plugin-updater (`update_check`, `update_install`); the page never calls the plugin. The
  automatic check runs 5 s after start and then every 6 h while the app is open (timer in `updates.svelte.ts`,
  period from `update_status`), skipped when a check completed less than an hour ago (marker file
  `last-update-check`, also written by manual checks; a timestamp in the future counts as due). A version
  dismissed with **Later** is not announced again by the automatic checks until the next start, a newer one is.
  The settings page header shows the version, **Check now** and the time of the marker (`update_status`). Checks go
  against `releases/latest/download/latest.json` (pre-releases are never offered). An exe with `uninstall.exe` next to it is
  the installed version (that is how the NSIS installer lays it out) and can update in place (passive mode, the
  installer relaunches Kladde); otherwise it is portable and gets a "Download" button. The session is saved before
  installing.

## Bundle and size policy

- The main bundle (~720 kB, ~245 kB gzip) contains CodeMirror, markdown-it, DOMPurify and the UI. Everything big
  is a **dynamic import** that loads on first use: the settings page, language grammars, `@codemirror/merge`, `@codemirror/lint` and
  grammar checking, Prettier and its plugins, sql-formatter, Mermaid (many chunks, up to ~1.5 MB for elk), KaTeX, the
  document viewer with docx-preview and JSZip (~180 kB, ~54 kB gzip together). Never import these statically.
- Measured with the document viewer added (`npm run build`): the JavaScript loaded at startup (the entry chunk and the
  chunks it imports) went from 736.96 kB to 741.09 kB (+4.1 kB, +0.6 %: the tab kind, routing and status bar code; Rollup
  also moved shared modules into a chunk named `dist-*`, which the entry imports), its gzip size stays at ~250 kB, the CSS
  grew by 0.08 kB. `docx-preview-*.js` (171 kB) and `DocumentView-*.js` (9.5 kB) are only fetched when a document tab is
  first shown.
- Fonts (JetBrains Mono, Inter) are bundled via Fontsource; an installed copy is preferred. KaTeX ships woff2 only
  (a Vite plugin strips woff/ttf).
- Release artifacts (v0.1.0): installer ~5 MB, portable exe ~8 MB (assets are embedded and compressed).

## Security and Tauri configuration

- A Markdown file is untrusted input: with `html: true` it can contain a `<form action="https://…">`, and clicking its
  button would replace the whole window with that page (unsaved edits are only as safe as the last backup). Three
  layers keep that from happening, each sufficient for the form case: the sanitizer drops the elements (forms and
  their controls, and `map`/`area`: an image map's `<area href>` navigates past the click handler, which only knows
  `<a>`; with `href=""` or `/` it even reloaded Kladde), the CSP's `form-action 'none'` (a directive that does not
  fall back to `default-src`) refuses the submission, and the navigation guard cancels any navigation but the
  first load of Kladde's own page. Mermaid's SVG does not pass our sanitizer (Mermaid runs DOMPurify with its own
  defaults, which keep a form in a label, and a diagram's init directive may change them), so `stripActive`
  (`markdown.ts`) removes the same elements from it before it is inserted; `<style>` has to stay there.
- CSP in `tauri.conf.json`: scripts `'self'`, styles `'self' 'unsafe-inline'` (CodeMirror injects styles;
  `dangerousDisableAssetCspModification: ["style-src"]` keeps Tauri from adding hashes that would disable
  `unsafe-inline`), images from `asset:`/https/data. HTTP requests to arbitrary servers are therefore done in Rust
  (LanguageTool), not in the page.
- `form-action 'none'` and `base-uri 'none'` are set explicitly: neither falls back to `default-src`.
- The asset protocol scope is one glob per image extension (`**/*.png`, …: the image tab's types from
  `IMAGE_EXTENSIONS` plus `svg`; `tests/unit/security-config.test.mjs` keeps the two lists equal), so images load from
  anywhere but nothing else does. Tauri matches scope globs case-insensitively (the `glob` crate's default options), so
  `PHOTO.PNG` loads too; `tests/e2e/navigation.test.mjs` pins that. Why it matters: the protocol takes the content type
  from the file's content first and falls back to *HTML* for an unknown extension, so with the old `**` scope an HTML
  file named `x.pdf` was served as a live page without a CSP. What the scope cannot do: a file named `x.png` whose
  content is HTML is still sniffed as `text/html`, and an uppercase `.SVG` is answered as `text/html` too (so it does
  not render in the preview either). Such a response is harmless as an `<img>`; the navigation guard below is what
  keeps it from ever being a page.
- **Navigation guard** (`navigation.rs`, wired in `create_main_window`): the main webview may only be at Kladde's own
  origin: `http://tauri.localhost` (what Tauri serves on Windows), `tauri://localhost` on other platforms, and the Vite
  dev server (`devUrl`) only in a `tauri dev` build (`cfg!(dev)`; a `--debug` build is not one). `on_navigation` cancels
  everything else, and the own origin is allowed **once** (`navigation::Guard`): Kladde never navigates itself, and
  Tauri answers every unknown path of its origin with `index.html`, so `href=""`, `/` or `other.md` would start the
  app again and lose the edits since the last backup. Only a dev build may reload (Vite does). Tauri also *allows* every
  URI the `url` crate cannot parse, without asking the callback, and WebView2 still navigates to some of them
  (`http://xn--a.invalid/`, an invalid IDNA label: error page, or the attacker's page when the name resolves). So
  `create_main_window` registers a second raw `NavigationStarting` handler (WebView2 COM, `webview2-com`, registered
  after Tauri's so it runs after it) that cancels whatever `Url::parse` rejects (`cancels_unparseable`); it only ever
  cancels, the decision for everything else stays in `navigation.rs`. `http`, `https` and `mailto` targets are handed to the system with the opener crate's `open_url`
  (the same rules as `workspace.openHref`: nothing else is ever opened; the hosts of Tauri's own protocols,
  `tauri.localhost`, `asset.localhost` and `ipc.localhost`, never); `file:`, `javascript:`, `data:`, `blob:`, `asset:`,
  `about:` and unknown schemes are dropped. `on_new_window` (`target=_blank`, `window.open`, a middle click) always
  answers *Deny*, with the same hand-over for web links. It is done in Rust and not by an event to the page: it needs no
  frontend that may itself be the confused party, works before the page has loaded, and the rules are plain unit
  tests (`classify_navigation`, `classify_new_window`). An isolated profile does not register the opener plugin: the
  URL goes into `KLADDE_OPEN_URL_LOG` instead, like for links the page opens, and is dropped (stderr only) when the
  variable is not set, so a test can never open the real browser or mail program. A reload is a navigation to the
  own origin and is cancelled like any other later one (F5 is swallowed and the native menu is gone, see below).
  A third handler, `FrameNavigationStarting` (`cancel_frame_navigations`), covers the frames inside the page: `on_navigation`
  only sees the top-level frame. It cancels everything but `about:srcdoc`, the document viewer's frame
  (`cancels_frame_navigation`), and logs `[navigation] cancelled frame navigation to <uri>`.
- A cancelled navigation's request may still reach the server (WebView2 reports `NavigationStarting` after the request
  was prepared; a form post is already on its way), so the guard is the last line, the sanitizer and the CSP the first.
- **Context menu**: WebView2's native menu depends on the target. On text you can type into it is Cut/Copy/Paste and
  spelling; anywhere else it is the page menu with Back, Forward, Refresh, Save as, Print and "Open link in new window",
  which would reload Kladde or navigate it. `App.svelte` therefore prevents `contextmenu` everywhere except on editable
  text (`keepsNativeMenu` in `native-menu.ts`: contenteditable such as CodeMirror, and enabled, writable text inputs and
  textareas). Selected text elsewhere (preview, read-only parts of the compare view) gets a small menu of our own with
  Copy (the existing `ContextMenu`); Ctrl+C works as before. In CodeMirror (the gutter, a read-only editor) the text
  comes from the editor's selection (`selectedText` in `native-menu.ts`), not from the page's, which only covers the
  rendered lines: "select all" in a long file would otherwise copy a screenful. The Copy puts plain text on the
  clipboard (the native one also had HTML). The large file view draws its own selection and has `user-select: none`,
  so it gets no menu (Ctrl+C works; it never had Copy in the native menu either). The tab bar keeps its own menu. Not verified, because tests
  cannot open native menus: that the native menu of an editable field has no navigation entries (it has none in the
  WebView2 versions we know).
- Documents are untrusted content under a CSP that allows https images: see "Document tabs" for how the viewer keeps
  them from fetching anything (a frame with a policy of its own, sandboxed, whose navigations the **frame guard**
  cancels). The page's CSP needed no change (`img-src` and `font-src` already allow `data:`; no `blob:`).
- Capabilities (`capabilities/default.json`) grant window show/focus/title/destroy/theme, dialogs, opener.
- Tauri's `dragDropEnabled: true` delivers file drops but disables HTML5 drag and drop in the page: tab reordering
  uses pointer events instead.
- The window starts hidden (`visible: false`) and is shown after the first render; the window-state plugin restores
  size/position but not visibility.
