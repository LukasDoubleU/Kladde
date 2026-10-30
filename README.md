<p align="center">
  <img src="assets/icon.svg" width="112" alt="Kladde icon">
</p>

<h1 align="center">Kladde</h1>

<p align="center">
  A lightweight text editor for Windows: a Notepad++ replacement with first-class Markdown.
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Kladde with a Markdown file and its live preview side by side">
</p>

*Kladde* is German for a rough-draft notebook.

## Motivation

A text editor, simple yet powerful like Notepad++, without becoming an IDE.

So: single files in tabs, no project tree, no Git, no language servers. It opens anything you throw at it,
starts in a fraction of a second, and never loses what you typed.

**Opinionated by design.** I build Kladde for my own use, so its features and defaults follow my preferences:
Windows only, English only, Catppuccin-themed (a pastel color palette), my own choice of keyboard shortcuts, and
only the features I need. Most of it should work as sensible defaults for others too, and you're welcome to use
it, but I may decline requests that don't fit how I work, and there is no promise of support.

## Features

**Editing**
- Tabs of single files: open from Explorer, the command line, drag and drop or `Ctrl+O`. A second launch
  hands its files to the running window.
- Syntax highlighting for ~145 languages, detected by extension, file name and shebang line. Grammars load
  on demand; batch files and logs have built-in highlighters too.
- Multiple cursors, column selection (`Alt`+drag), find and replace with regex, go to line, word wrap.
- Line commands (duplicate, move, join, sort, comment, upper / lower case, …), all in the command palette and
  all rebindable. Keyboard shortcut presets (Notepad++, VS Code), chords such as `Ctrl+K Ctrl+C` and a shortcut
  editor in the command palette; see [Shortcuts](#shortcuts).
- Format document or selection (`Shift+Alt+F`) picks the formatter from the tab's language: JSON (numbers and
  strings stay exactly as written; also *Minify JSON*), XML and SVG (own formatter, text, comments and CDATA
  untouched), SQL (sql-formatter, dialect from the language), JavaScript, TypeScript, JSX, TSX, CSS, SCSS,
  LESS, HTML, Vue, Markdown and YAML (Prettier). With a selection only those lines are formatted; indentation
  follows the tab settings. The formatters load on first use, so they cost nothing at startup.
- Optional spell checking with the Windows dictionaries.
- Optional grammar and style checking with [LanguageTool](https://languagetool.org) (see below).

**Compare**
- Side-by-side diff of two open tabs, a tab and its file on disk, or a tab and the clipboard
  (**Compare with…** in the command palette). Changed lines and the changed words in them are marked;
  both sides are highlighted with the file's language.
- `F7` / `Shift+F7` jump to the next / previous change. Options for ignoring whitespace and case, and an
  inline view with the removed lines above the added ones.
- When a file with unsaved changes also changed on disk, the banner offers **Compare**.
- Compare tabs are snapshots and read-only; they are not restored after a restart.

**Markdown**
- Live preview side by side or full size (`Ctrl+Shift+V`), following the editor as you scroll.
- GitHub-flavoured: tables, task lists, autolinks, heading anchors, highlighted code blocks; local images
  resolve relative to the file.
- Mermaid diagrams (```` ```mermaid ````) and math with KaTeX (`$inline$`, `$$block$$`, ```` ```math ````), in the
  colors of the current theme. Both load only when a document uses them and work offline.
- Paste an image from the clipboard and it is saved next to the file (`assets/` by default) and linked.

**Files**
- Hot exit: closing the window never asks. All tabs, including unsaved changes, come back on the next
  start, even after a crash, while the files on disk stay untouched until you save.
- Backups: the text of every unsaved tab is written to disk within about 0.3 seconds of a change, also
  while you keep typing (large documents wait up to 3 seconds between writes), and whenever the window
  loses focus. After a crash at most the last fraction of a second is missing.
- Crash-safe saving: a save writes a temporary file and replaces the original in one step, keeping its
  attributes and permissions, so a crash or a full disk never leaves a half-written file. The session
  and the backups are written the same way.
- Backup versions: up to five older backups per unsaved tab (at least five minutes apart). **Restore an
  older backup of this tab** in the command palette lists them and opens the chosen one in a new tab; it
  never overwrites the current tab. Backups of tabs you saved or closed are deleted.
- Encodings: detects UTF-8, UTF-16 (BOM) and legacy code pages; reopen or save with another encoding;
  keeps CRLF, LF or CR line endings.
- Large files: anything above 32 MB opens in the large file view, which indexes lines in the background and
  only reads what is on screen. Multi-GB logs open instantly, UTF-8, UTF-16 and legacy code pages alike.
  Search runs in the background (Esc cancels it) with Aa (match case; Unicode-aware when off) and .*
  (regular expressions, `^` and `$` per line), plus go to line. Log files are highlighted like in the editor.
  A file that is still being written is followed like `tail -f`; "Open in editor…" loads files up to 256 MB
  into a normal tab.
- Editing large files: you can type, select, delete, paste, cut, copy and undo/redo (`Ctrl+Z`, `Ctrl+Y`) in
  the large file view, and use the line commands (delete, duplicate, move, insert blank line, upper/lower
  case) under their usual shortcuts. Only the changes are kept in memory, so a multi-GB file stays as cheap
  to edit as a small one. Saving streams the document into a temporary file next to the original and
  replaces it in one step, keeping encoding, BOM and line endings (new line breaks use the file's most
  common one). Unsaved edits are part of hot exit: they are backed up as a journal of the changes, and a
  crash restores them. If the file changed on disk in the meantime, Kladde asks instead of applying them.
  While a large file has unsaved edits, Kladde does not follow it any more and other programs cannot write
  to it (they can still read it).
- External changes: unmodified tabs reload when the file changes on disk, and the active tab follows a
  growing log live; otherwise a banner asks.
- Image viewer for PNG, JPEG, GIF, WebP and more.
- Windows integration: Kladde offers itself as a default editor (once, on first start), appears in "Open
  with" and has an optional "Edit with Kladde" Explorer context menu entry. Per user, no admin rights.

**Look**
- All four [Catppuccin](https://catppuccin.com) flavors (Mocha, Macchiato, Frappé, Latte) with a choice of the
  14 accent colors, optionally following the Windows light/dark setting; Mocha with Rosewater is the default.
  Your own colors go into a `theme.css` (see [Themes](#themes)).
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) with ligatures in the editor and
  [Inter](https://rsms.me/inter/) for the interface, both bundled.
- Zoom with `Ctrl`+wheel or `Ctrl+Plus` / `Ctrl+Minus`.

## Install

Download the latest version from [Releases](https://github.com/LukasDoubleU/Kladde/releases): the installer
(`…_x64-setup.exe`, installs for the current user without admin rights) or the portable `…_x64_portable.exe`.
Kladde needs Windows 10 or 11 with WebView2, which ships with Windows 11. The files are not code-signed yet,
so SmartScreen may ask for confirmation on the first start. You can also [build it yourself](#building).

### Updates

Kladde looks for a newer version a few seconds after start, at most once a day, in the background. When there
is one, a banner says so: **Update now** (downloads the installer, checks its signature, installs it and
restarts Kladde; unsaved text is backed up first and comes back), **Release notes** or **Later**. The command
**Check for updates** asks right away and tells you when you are up to date. The portable exe cannot replace
itself, so its banner offers **Download**, which opens the release page.

The check is one request for `latest.json` from the GitHub release page of this repository; Kladde sends
nothing but the request itself (GitHub sees your IP address, as with any download), no identifier and nothing about your files. Update packages are signed with a key whose public half is built into Kladde,
so a tampered download is rejected. Set `checkForUpdates` to `false` in the settings to turn the automatic
check off (the command keeps working). Versions before the one that introduced updates must be updated by hand once.

### Default editor and Explorer

Windows does not let apps make themselves the default; you choose that in its settings. So Kladde registers
itself as a capable app (under `HKCU`, nothing machine-wide) and then opens the Windows default apps page for
you. On the first start a banner offers this: **Choose file types…**, **Not now** (asks again next time) or
**Don't ask again** (stored in the data folder, not in `settings.json`). The same is available any time from
the command palette:

- **Set Kladde as default editor…** lets you opt into groups of file types (plain text, logs, Markdown, config
  and data files, scripts and source code) and the context menu entry, registers them and opens the Windows
  settings. Kladde also shows up in "Open with" for every file.
- **Toggle "Edit with Kladde" in the Explorer context menu** adds or removes only that entry (on Windows 11 it
  is under "Show more options").
- **Remove Kladde from Windows file associations** undoes everything Kladde wrote. The uninstaller does the
  same. Other programs' associations are never touched.

The portable exe registers its current location; if it moves, or a newer version supports more file types,
Kladde refreshes an existing registration silently at the next start.

## Shortcuts

`Ctrl+Shift+P` (or `F1`, `Ctrl+Shift+A`, `Ctrl+3`) lists every command with its shortcut.

| Keys | Action |
|---|---|
| `Ctrl+N` or `Ctrl+T` / `Ctrl+O` | New tab, open file |
| `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+Alt+Shift+S` | Save, save as, save all |
| `Ctrl+Alt+S` | Settings page |
| `Ctrl+W` / `Ctrl+Shift+T` | Close tab, reopen closed tab |
| `Ctrl+Tab` or `Ctrl+PageDown` / `Ctrl+Shift+Tab` or `Ctrl+PageUp` | Next / previous tab |
| `Alt+Left` / `Alt+Right`, mouse back / forward | Back / forward through recently used tabs |
| `F5` | Reload the file from disk |
| `Alt+Shift+W` | Reveal the file in Explorer |
| `Ctrl+F` / `Ctrl+H` / `F3` | Find, replace, find next |
| `Ctrl+G` | Go to line |
| `Ctrl+D` or `Ctrl+Shift+K` | Delete the line (or all lines of the selection) |
| `Ctrl+Shift+D` / `Ctrl+Shift+L` | Select the next occurrence / all occurrences of the selection (`Ctrl+D` used to do this; it is "delete line" here) |
| `Alt+Up` / `Alt+Down` | Move the line up / down |
| `Shift+Alt+Up` / `Shift+Alt+Down` | Duplicate the line above / below |
| `Ctrl+J` | Join the lines |
| `Ctrl+/` / `Shift+Alt+A` | Toggle line comment / block comment |
| `Ctrl+]` / `Ctrl+[` | Indent / outdent |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` / `Ctrl+Alt+[` / `Ctrl+Alt+]` | Fold, unfold, fold all, unfold all |
| `F7` / `Shift+F7` | In a compare tab: next / previous change |
| `Ctrl+Shift+V` | Markdown preview: side by side, preview only, off |
| `Shift+Alt+F` | Format document or selection |
| `Alt+Z` | Toggle word wrap |
| `Ctrl+Plus` / `Ctrl+Minus` / `Ctrl+0` | Zoom in, out, reset |

The defaults work well with mouse gesture tools that send `Ctrl+T`, `Ctrl+W`, `F5` and `Alt+Left` /
`Alt+Right`. Everything else in the palette that has no key here (sort lines, upper / lower case, trim
trailing whitespace, …) can get one.

### Presets

The `keymap` setting (or **Choose keyboard shortcut preset…** in the command palette) picks the base keys:

| Preset | |
|---|---|
| `default` | The table above: VS Code and CodeMirror keys, plus `Ctrl+T`, `F5` and `Alt+Left` / `Alt+Right`. |
| `notepad++` | Notepad++'s keys: `Ctrl+D` duplicates the line, `Ctrl+L` cuts it, `Ctrl+Shift+L` deletes it, `Ctrl+Shift+Up` / `Down` move lines, `Ctrl+J` joins, `Ctrl+Q` / `Ctrl+Shift+Q` comment, `Ctrl+K` / `Ctrl+Shift+K` add / remove line comments, `Ctrl+U` / `Ctrl+Shift+U` lower / upper case, `Ctrl+B` matching bracket, `Alt+0` / `Alt+Shift+0` fold / unfold all, `Ctrl+R` reload, `Ctrl+Alt+S` save as, `Ctrl+Shift+S` save all (so the settings page has no key here; use the command palette). `Ctrl+T`, `F5` and `Alt+Left` / `Alt+Right` stay for mouse gestures. |
| `vscode` | VS Code's keys: `Ctrl+D` selects the next occurrence, `Ctrl+Shift+K` deletes the line, `Ctrl+L` selects it, and the `Ctrl+K` chords `Ctrl+K Ctrl+C` / `Ctrl+K Ctrl+U` (add / remove line comment), `Ctrl+K Ctrl+0` / `Ctrl+K Ctrl+J` (fold / unfold all), `Ctrl+K Ctrl+X` (trim trailing whitespace), `Ctrl+K V` (preview), `Ctrl+K Ctrl+S` (change a shortcut) and `Ctrl+,` (settings page, besides `Ctrl+Alt+S`). |

### Chords

A key can be several combinations in a row, written with spaces: `Ctrl+K Ctrl+C`. After the first one the
status bar says what Kladde waits for; the chord is cancelled by `Esc` or after two seconds, and the first
key does nothing else meanwhile. A key cannot be a command and the start of a chord at the same time: the
chord wins, and the shortcut editor warns about it.

### Changing shortcuts

Run **Change keyboard shortcut…** from the command palette: pick a command (the list shows its current
keys and its id), then **Set shortcut…**, **Add another shortcut…**, **Remove shortcut** or **Reset to
default**. In the dialog press the new keys (a second key makes a chord), then `Enter`. Kladde names the
command that already uses the key and offers to replace it, writes `keybindings.json` and applies it at
once. Plain letters are refused as the first key because they are for typing.

You can edit `keybindings.json` yourself (**Open keyboard shortcuts**) as well. Each command takes a key, a
list of keys, or `null` to unbind it; entries replace the keys the preset gives that command, everything not
listed keeps them. Every editing command is a command, so unbinding one really frees its key:

```json
{
  "file.new": ["Ctrl+N", "Ctrl+T"],
  "editor.sortLinesAscending": "Ctrl+Alt+O",
  "editor.toUpperCase": "Ctrl+K Ctrl+U",
  "tab.back": null
}
```

Entries that only repeat a command's built-in default are ignored while a preset is selected, so a
`keybindings.json` that lists every default (as older versions created) does not pin them.
## Grammar checking

Kladde can check grammar, style and spelling with [LanguageTool](https://languagetool.org). It is off until
you set it up, and nothing is sent anywhere before you turn it on.

1. Set `languageToolServer` in `settings.json`:
   - `http://localhost:8081` for a LanguageTool server on your machine (the HTTP server from the
     LanguageTool download; **nothing leaves your machine**), or
   - `https://api.languagetool.org` for the public API. Your text is then **sent to a third party**: Kladde
     asks for confirmation once, and the public API limits requests (about 20 a minute), so long documents
     are checked in pieces.
2. Run **Toggle grammar checking (LanguageTool)** from the command palette. The state is remembered.

Findings are underlined (red wavy: spelling, blue wavy: grammar, orange dotted: style). Hover one to read
the message and click a suggestion to apply it; it is a normal edit you can undo. **Ignore word** / **Ignore
rule** hides a finding until Kladde restarts. The status bar shows the number of findings.

- Only Markdown and plain text are checked, unless `languageToolAllFiles` is on. In Markdown, front matter,
  code, math, links' targets, HTML and URLs are left out.
- Kladde checks the paragraphs around the visible part of the document, about a second after you stop
  typing or scrolling. Unchanged paragraphs are remembered, so only edited ones are sent again.
- The language is detected automatically. Pick one for a file with **Set grammar checking language…**
  (remembered with the session), or put `lang: de` in the front matter of a Markdown file.
- If the server is unreachable or refuses, Kladde reports it once, keeps your text as is and tries again
  later with growing pauses.
- It works next to the Windows spell checker; turn that off with **Toggle spell checking** if the double
  underlines bother you.

## Settings

**Settings** in the command palette, or `Ctrl+Alt+S`, opens the settings page: a tab with every setting in
sections (editor, appearance, Markdown preview, large files, keyboard, spelling and grammar, updates, Windows
integration), a search box (it matches the label, the description and the setting's name), a switch, number box,
list or text box per setting, a mark on the ones that differ from the default and **Reset to default** for each.
Changes are written to `settings.json` at once and applied at once; entries Kladde does not know stay in the file,
and a setting set back to its default is removed from it. `Escape` clears the search, then returns to the previous
tab. The page also links to `settings.json`, the shortcut editor and `theme.css`.

**Open settings (settings.json)** in the command palette opens the file itself; saving it applies the changes, and
the page shows them. The table lists every setting:

| Setting | Default | |
|---|---|---|
| `fontFamily`, `fontSize` | JetBrains Mono, `14` | editor font |
| `fontLigatures` | `true` | ligatures such as `=>` and `!=` |
| `uiFontFamily` | Inter | interface font |
| `theme` | `mocha` | `mocha`, `macchiato`, `frappe`, `latte` or `system` (follow Windows); `dark` and `light` still work as names for Mocha and Latte |
| `themeLight`, `themeDark` | `latte`, `mocha` | the flavors `system` uses while Windows is in light or dark mode |
| `accent` | `rosewater` | `rosewater`, `flamingo`, `pink`, `mauve`, `red`, `maroon`, `peach`, `yellow`, `green`, `teal`, `sky`, `sapphire`, `blue` or `lavender` |
| `tabSize`, `insertSpaces` | `4`, `true` | |
| `wordWrap`, `lineNumbers`, `highlightActiveLine` | `false`, `true`, `true` | |
| `spellCheck` | `false` | can also be toggled from the command palette |
| `grammarCheck` | `false` | grammar checking at start; needs `languageToolServer`; toggled from the command palette |
| `languageToolServer` | `""` | address of a LanguageTool server, e.g. `http://localhost:8081`; empty means not set up |
| `languageToolLanguage` | `auto` | `auto` detects the language, or a code such as `de-DE` or `en-GB` |
| `languageToolVariants` | `en-US,de-DE` | variants preferred when the language is detected (`en` can be US, UK, …) |
| `languageToolAllFiles` | `false` | check every text file, not only Markdown and plain text |
| `markdownPreview` | `split` | how Markdown files open: `split`, `only` or `off` |
| `pasteImageFolder` | `assets` | folder for pasted images, relative to the Markdown file |
| `largeFileThresholdMB` | `32` | larger files open in the large file view |
| `keymap` | `default` | base for the keyboard shortcuts: `default`, `notepad++` or `vscode` |
| `offerDefaultEditor` | `true` | offer once at start to register Kladde as a default editor candidate |
| `checkForUpdates` | `true` | look for a newer version at start (once a day, contacts GitHub); the command works either way |

Settings, keyboard shortcuts, the custom theme, the session, the time of the last update check and backups of
unsaved text live in
`%APPDATA%\io.github.lukasdoubleu.kladde`.

### Themes

The `theme`, `themeLight`, `themeDark` and `accent` settings pick a built-in look; the window's title bar follows
(light for Latte, dark for the others). An unknown name is reported and replaced by the default. The light theme
that older versions shipped was replaced by Latte, so `"theme": "light"` now shows Latte.

For anything else, run **Open custom theme (theme.css)** in the command palette. It creates `theme.css` in the
config folder with every variable listed (commented out, with the values of the current theme). The file is loaded
after the built-in theme, so it can override any variable, and saving it applies it immediately.
Everything is colored through these CSS variables: the editor, gutters, search panel, preview (including code
blocks), Mermaid diagrams, compare view, status bar, dialogs, picker and large file viewer.

```css
:root {
  --ctp-base: #1a1b26;        /* retints every surface that is built from the palette */
  --accent: #ff9e64;
  --tok-keyword: #bb9af7;
}
```

| Variables | Used for |
|---|---|
| `--ctp-rosewater` … `--ctp-crust` (26) | the Catppuccin palette; all roles below are built from it. `--ctp-accent` is the chosen accent |
| `--bg`, `--bg-alt`, `--bg-hover`, `--border` | editor and preview background; bars, panels and dialogs; hovered and selected rows; lines |
| `--fg`, `--fg-dim` | text; secondary text, icons |
| `--accent`, `--accent-fg`, `--caret` | accent (focus, selected rows, buttons, diagram borders); text on the accent; text cursor |
| `--link`, `--error`, `--dirty`, `--banner` | links in dialogs; errors; the unsaved-changes mark; background of the "file changed" banner |
| `--selection`, `--selection-match`, `--active-line`, `--bracket-match`, `--special-char` | selection, other occurrences of the selection, current line, matching bracket, control characters |
| `--line-number`, `--active-line-number` | gutter |
| `--search-match`, `--search-match-border`, `--search-match-selected` | find matches |
| `--diff-del-bg`, `--diff-del-text`, `--diff-del-mark`, `--diff-add-bg`, `--diff-add-text`, `--diff-add-mark` | compare view: changed lines, changed words, markers |
| `--tok-keyword`, `--tok-string`, `--tok-escape`, `--tok-number`, `--tok-comment`, `--tok-function`, `--tok-type`, `--tok-property`, `--tok-variable`, `--tok-operator`, `--tok-punctuation`, `--tok-meta`, `--tok-heading`, `--tok-link`, `--tok-invalid`, `--tok-inserted`, `--tok-deleted`, `--tok-date`, `--tok-warn` | syntax highlighting in the editor and in code blocks of the preview |

Colors can be written in any CSS syntax. Fonts are not part of the theme: use `fontFamily` and `uiFontFamily`
in `settings.json`. If you set `--accent` yourself, also set `--accent-fg` to a readable text color on it.

## Building

Requirements: [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) (stable, MSVC toolchain) and the
Visual Studio C++ Build Tools.

```sh
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # release build and installer
npm run check         # type-check the frontend
cd src-tauri && cargo test
```

## Contributing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), e.g.
`feat(preview): render Mermaid diagrams` or `fix: keep the cursor when reloading a file`. `npm install`
sets up a commit-msg hook that checks this, and CI checks it again. Versions follow
[Semantic Versioning](https://semver.org) and are derived from these messages: releases are created on demand
by the Release workflow, which also writes the [changelog](CHANGELOG.md).

How Kladde is built, how it is tested and how work is organized is described in [docs/](docs/architecture.md)
(architecture, decisions, testing, development, roadmap); [CLAUDE.md](CLAUDE.md) is the short version for coding
agents.

## How it works

[Tauri 2](https://v2.tauri.app) with a Rust core for file I/O, encodings, the large file viewer and the
session; [CodeMirror 6](https://codemirror.net) as the editor; [Svelte 5](https://svelte.dev) for the
interface; [markdown-it](https://github.com/markdown-it/markdown-it) and
[DOMPurify](https://github.com/cure53/DOMPurify) for the preview, with
[Mermaid](https://mermaid.js.org) and [KaTeX](https://katex.org) loaded on demand, and
[Prettier](https://prettier.io) and [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) for
formatting. All open text tabs share one editor
view and keep their own state, including undo history, so switching tabs is instant.

## Roadmap

Planned features and ideas are tracked as [issues](https://github.com/LukasDoubleU/Kladde/issues), among them
code signing and more formatters (TOML); see also [docs/roadmap.md](docs/roadmap.md).

## License

[MIT](LICENSE). Kladde bundles JetBrains Mono and Inter under the
[SIL Open Font License](https://openfontlicense.org); the color palette is
[Catppuccin](https://github.com/catppuccin/catppuccin) (MIT).
