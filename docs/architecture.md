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
| `lib.rs` | Tauri commands, plugins, startup (single instance, `--unregister-integration` CLI flag) |
| `files.rs` | Reading with encoding detection (BOM → UTF-8 validity → chardetng), BOM and line-ending handling, writing with `write_safely` |
| `large.rs` | The large file viewer backend: index, search, editing, streaming save, hot-exit journal |
| `pieces.rs` | The piece table behind large-file editing (pure data structure, no I/O, no encodings) |
| `session.rs` | Data/config folders, session JSON, backups and backup versions, config files, the isolated profile |
| `integration.rs` | Windows registration (ProgID, capabilities, "Open with", context menu) under a passed-in registry root |
| `update.rs` | Update check/install on top of tauri-plugin-updater |
| `languagetool.rs` | HTTP client for LanguageTool (`ureq`, Windows TLS) |

Key mechanisms:

- **Text model at the boundary:** the editor always works with `\n`. `files::read` normalizes CRLF/CR and reports
  the original `eol`, `encoding`, `bom`, `binary` (NUL bytes) and `lossy` (invalid sequences); `files::write`
  converts back. UTF-16 is encoded by hand (encoding_rs only decodes it). Unmappable characters in a legacy
  encoding are an error, never silently replaced.
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
| `lib/format.ts`, `format-xml.ts`, `formatters.ts` | Own JSON and XML formatters; dispatch by language to lazily loaded Prettier and sql-formatter |
| `lib/compare.ts` | Merge views for compare tabs (`@codemirror/merge`, custom diff for ignore whitespace/case) |
| `lib/grammar.ts`, `grammar-text.ts` | LanguageTool: lint integration (lazy) and the pure text side (Markdown masking via LanguageTool's `data` format, paragraphs, request budget, offset mapping) |
| `lib/theme.ts`, `src/themes.css`, `src/app.css` | Flavors, accents, role variables, user `theme.css` |
| `lib/integration.svelte.ts`, `components/DefaultEditor.svelte` | Default-editor offer and Explorer integration UI |
| `lib/updates.svelte.ts`, `components/UpdateBanner.svelte` | Update check banner |
| `lib/linehighlight.ts` | Highlights visible lines of the large viewer with the editor grammars (`tok-*` classes) |
| `components/LargeFileView.svelte` | The large file view: visible lines fetched from Rust, hand-drawn scrollbar, caret/selection as line/column pairs, a hidden `<textarea>` that receives typing, IME and paste at the caret, a queue (`enqueue`) that runs keys and edits one after another so positions are never stale, search toolbar |
| `lib/large-edit.ts` | Pure helpers of the large file view (caret movement over one line's text, words, spans for selection/caret, the editor commands it supports); unit-tested |
| `lib/settings.svelte.ts` | Flat settings with defaults; `loadSettings` only accepts keys whose type matches the default |
| `lib/api.ts` | Typed wrappers of all Tauri commands |

### Tabs and the editor

- Tab kinds: `text`, `large` (the document lives in Rust), `image`, `compare`. Tab metadata lives in Svelte `$state` (`workspace.tabs`); editor
  state does not.
- **One shared `EditorView`** for all text tabs. Inactive tabs keep their `EditorState` (with undo history) in the
  non-reactive `runtime` map; `activate()` swaps states with `view.setState` and restores the scroll position.
  View-wide options (wrap, indentation, gutters, spelling) are reapplied after a swap (`applyViewOptions`).
- Dirty tracking compares the document with the saved `Text` (`rt.saved`), plus `metaDirty` for encoding or
  line-ending changes that need saving although the text is unchanged.
- A reload is applied as the minimal change (`minimalChange`), as an undoable edit, so the cursor stays and
  following a log is cheap.
- Opening a file into an untouched empty "new N" tab replaces it (Notepad++ behaviour). Images open in an image tab;
  files above `largeFileThresholdMB` (32) in the large viewer; "Open in editor…" loads large files up to 256 MB.
- Tab history (`Alt+Left`/`Alt+Right`, mouse back/forward) is a browser-like stack of activated tabs, not
  persisted.

### Session and hot exit (zero data loss)

- Closing the window never asks: `onCloseRequested` awaits `saveSession()`. Closing a single dirty tab does ask.
- `scheduleSession()` is a **throttle**, not a debounce: the first change arms a timer (300 ms plus size/500 ms,
  at most 3 s), later changes do not push it back, so continuous typing is backed up. Focus loss saves immediately.
- `writeSession()` snapshots each tab's state and version together before awaiting writes, so edits made during a
  write are not marked as backed up. Writes are serialized through `sessionChain`.
- Data folder layout: `session.json` (tab list, active tab, wrap, spell check, zoom, per-tab language/encoding/eol/
  preview/cursor/scroll, `hasBackup`), `backup/<id>.txt` (current text of dirty or untitled tabs) and
  `backup/<id>.<n>.txt` (up to 5 older versions, at least 5 minutes apart), plus marker files
  (`no-default-editor-offer`, `last-update-check`). Config folder: `settings.json`, `keybindings.json`, `theme.css`.
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

### Preview

- markdown-it (`html: true`, linkify) with own rules: `data-line` on blocks (scroll sync from the editor), heading
  ids, task-list checkboxes, highlighted fences using the editor grammars (`highlightCode` + `classHighlighter`).
- Output is sanitized with DOMPurify; local image `src` are rewritten to the asset protocol (`convertFileSrc`).
  Links: http(s)/mailto open externally, relative paths open in Kladde, `#anchors` scroll.
- Mermaid: fences become placeholders; `renderDiagrams` draws them after insertion (`securityLevel: "strict"`),
  caches SVGs by source and theme, keeps the stale SVG while re-rendering, shows errors inline.
- Math: own markdown-it rules (`$…$`, `$$…$$`, ```` ```math ````) rendered by KaTeX once its chunk is loaded;
  `$5 and $10` stays text. A re-render is triggered when a lazy dependency finishes loading.
- SVG files get an image preview; pasting an image into a saved Markdown file writes it to `pasteImageFolder`.

### Compare tabs

- Kind `compare`: two text snapshots in `workspace.compareData`, shown by `Compare.svelte` (kept alive while hidden,
  so it keeps its scroll position) through `compare.ts`. Ignore whitespace/case use a custom diff function passed to
  `@codemirror/merge`. Not part of the session.

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
  check runs 5 s after start, at most once per day (marker file `last-update-check`), against
  `releases/latest/download/latest.json` (pre-releases are never offered). An exe with `uninstall.exe` next to it is
  the installed version (that is how the NSIS installer lays it out) and can update in place (passive mode, the
  installer relaunches Kladde); otherwise it is portable and gets a "Download" button. The session is saved before
  installing.

## Bundle and size policy

- The main bundle (~695 kB, ~237 kB gzip) contains CodeMirror, markdown-it, DOMPurify and the UI. Everything big
  is a **dynamic import** that loads on first use: language grammars, `@codemirror/merge`, `@codemirror/lint` and
  grammar checking, Prettier and its plugins, sql-formatter, Mermaid (many chunks, up to ~1.5 MB for elk), KaTeX.
  Never import these statically.
- Fonts (JetBrains Mono, Inter) are bundled via Fontsource; an installed copy is preferred. KaTeX ships woff2 only
  (a Vite plugin strips woff/ttf).
- Release artifacts (v0.1.0): installer ~5 MB, portable exe ~8 MB (assets are embedded and compressed).

## Security and Tauri configuration

- CSP in `tauri.conf.json`: scripts `'self'`, styles `'self' 'unsafe-inline'` (CodeMirror injects styles;
  `dangerousDisableAssetCspModification: ["style-src"]` keeps Tauri from adding hashes that would disable
  `unsafe-inline`), images from `asset:`/https/data. HTTP requests to arbitrary servers are therefore done in Rust
  (LanguageTool), not in the page.
- The asset protocol scope is `**` so the preview can show local images anywhere.
- Capabilities (`capabilities/default.json`) grant window show/focus/title/destroy/theme, dialogs, opener.
- Tauri's `dragDropEnabled: true` delivers file drops but disables HTML5 drag and drop in the page: tab reordering
  uses pointer events instead.
- The window starts hidden (`visible: false`) and is shown after the first render; the window-state plugin restores
  size/position but not visibility.
