# Kladde

A lightweight text editor for Windows: a Notepad++ replacement with first-class Markdown.

*Kladde* is German for a rough-draft notebook. It is a text editor, not an IDE: single files
in tabs, no project tree, no Git, no language servers.

## Features

- **Tabs of single files**: open from Explorer, the command line, drag and drop or `Ctrl+O`.
  A second launch hands its files to the running window.
- **Syntax highlighting for ~145 languages**, detected by extension, file name and shebang line.
  Grammars load on demand. Built-in highlighters for batch files and logs.
- **Markdown preview** side by side or full size (`Ctrl+Shift+V`): GitHub-flavoured Markdown with
  tables, task lists, highlighted code blocks and local images; the preview follows the editor.
  **Paste an image** into a Markdown file and it is saved next to it (`assets/` by default) and linked.
- **Large files**: files above 32 MB open in a read-only viewer that indexes lines in the
  background and only reads what is on screen, with search and go-to-line. Multi-GB logs open instantly.
- **Encodings**: detects UTF-8, UTF-16 (BOM) and legacy code pages; reopen or save with another
  encoding; keeps CRLF / LF / CR line endings.
- **Hot exit**: closing the window never asks; all tabs, including unsaved text, come back on the next start.
- **External changes**: unmodified tabs reload automatically when the file changes on disk
  (the active tab is followed live, like `tail -f`); otherwise a banner asks.
- Image viewer, multiple cursors, column selection (`Alt`+drag), find and replace with regex,
  word wrap, zoom. Theme: [Catppuccin Mocha](https://catppuccin.com) with Rosewater accent (a light theme is available).

## Shortcuts

`Ctrl+Shift+P` (or `F1`) lists all commands with their shortcuts. The most important ones:

| Keys | Action |
|---|---|
| `Ctrl+N` or `Ctrl+T` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | New, open, save, save as |
| `Ctrl+W` / `Ctrl+Shift+T` | Close tab, reopen closed tab |
| `Ctrl+Tab` or `Ctrl+PageDown` / `Ctrl+Shift+Tab` or `Ctrl+PageUp` | Next / previous tab |
| `Alt+Left` / `Alt+Right`, mouse back / forward | Back / forward through recently used tabs |
| `F5` | Reload the file from disk |
| `Ctrl+F` / `Ctrl+H` / `F3` | Find, replace, find next |
| `Ctrl+G` | Go to line |
| `Ctrl+Shift+V` | Cycle Markdown preview: side by side, preview only, off |
| `Alt+Z` | Toggle word wrap |
| `Ctrl+Plus` / `Ctrl+Minus` / `Ctrl+0` | Zoom |

Change them with **Open keyboard shortcuts** in the command palette, which opens
`keybindings.json` (`"action.id": "Ctrl+K"`, a list of keys, or `null` to unbind).

## Settings

**Open settings** in the command palette opens `settings.json`; saving it applies the changes.

| Setting | Default |
|---|---|
| `fontFamily`, `fontSize` | Cascadia Mono, 14 |
| `tabSize`, `insertSpaces` | 4, true |
| `wordWrap`, `lineNumbers`, `highlightActiveLine` | false, true, true |
| `theme` | `dark` (Catppuccin Mocha), `light` or `system` |
| `largeFileThresholdMB` | 32 |
| `markdownPreview` | `split`, `only` or `off`: how Markdown files open |
| `pasteImageFolder` | `assets` |

## Building

Requirements: Node.js 20+, Rust (stable, MSVC toolchain) and the Visual Studio C++ Build Tools.
WebView2 ships with Windows 11.

```sh
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # release build and installer in src-tauri/target/release/bundle
cd src-tauri && cargo test
```

## Stack

[Tauri 2](https://v2.tauri.app) with a Rust core for file I/O, encodings, the large file
viewer and sessions; [CodeMirror 6](https://codemirror.net) as the editor;
[Svelte 5](https://svelte.dev) for the UI; [markdown-it](https://github.com/markdown-it/markdown-it)
and [DOMPurify](https://github.com/cure53/DOMPurify) for the preview.
