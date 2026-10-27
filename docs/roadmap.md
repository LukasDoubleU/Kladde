# Roadmap and known gaps

State after v0.2.0 (end of October 2026). Issues #1–#4, #6–#8 and #10 are closed.

## Open issues

### #5 Large files: editing in the viewer
Done: UTF-16, regex and Unicode search (cancellable, progressive), highlighting of visible lines, following growing
files, "Open in editor…" up to 256 MB. Missing — a real streaming editor:
- a piece table in Rust (original file + append-only buffer) so edits never copy the file;
- line-index maintenance for edits (offset deltas or re-indexing the touched region);
- caret, selection, input, undo/redo in the viewer (bounded history);
- saving by streaming into a temporary file that replaces the original (keep `write_safely` guarantees, encoding,
  BOM, line endings);
- hot-exit backups as an edit journal instead of full text;
- external changes while edits are pending; search and highlighting over the edited view.
Viewer limits: a search match cannot span chunks (~8 MB, 64 KB overlap inside very long lines); a regex match over
a line break is highlighted on its first line only.

### #9 Code signing
Auto-update is done. Missing: Authenticode signing so SmartScreen does not warn. Options: Azure Artifact Signing
(formerly Trusted Signing) or SignPath Foundation (free for open source, manual application). Wire it in through
Tauri's `bundle.windows.signCommand` (signs exe, installer and uninstaller during the build; the portable exe is a
copy of the signed `kladde.exe`). The updater's minisign `.sig` must be created after Authenticode signing.

### #11 End-to-end tests on the CI runner
See [testing.md](testing.md#ci): WebView2 on the runner ignores the remote-debugging argument. Also: occasional
timeouts in long local full runs.

## Smaller follow-ups (no issues yet)

- **Grammar (LanguageTool):** keyboard access to findings (F8 / `lintKeymap`, apply fix by key); persistent "ignore
  word/rule" (a user dictionary); the public-API consent lives in WebView `localStorage` instead of the data folder;
  untested against a real local LanguageTool server; auto-detection is weak on very short paragraphs.
- **Formatters:** TOML (Prettier has none); JSON with comments (`.jsonc` uses the strict own formatter and reports an
  error); GraphQL (no language entry); indented Sass; Prettier options (quotes, print width) are not configurable.
- **Keys:** "insert line above", Notepad++ "split lines"; non-US keyboard layouts may need different punctuation
  keys (`Ctrl+/` etc.).
- **Themes:** commands to switch flavor/accent from the palette; edits to `theme.css` or `settings.json` made outside
  Kladde apply only after a restart (saving in Kladde applies at once); a user-set `--accent` does not adjust
  `--accent-fg`; the notice for an invalid value does not list the valid ones.
- **Compare:** "Compare with…" in the tab context menu and a default shortcut; the clipboard source is not covered
  by an e2e test.
- **Preview:** an unfinished Mermaid diagram shows the error box while typing (no debounce); KaTeX inside Mermaid
  labels is untested; Mermaid brings a second copy of KaTeX (harmless, both lazy).
- **Windows integration:** two portable copies would overwrite each other's registration (silent re-register on
  exe path change); the file-type groups and extension lists may need tuning; Windows 10 ignores the default-apps
  deep link parameter (the page still opens).
- **Updates:** pre-releases are never offered (`releases/latest`); v0.1.0 has no updater.
- **Data loss:** "Restore an older backup" only exists for tabs that still have a backup (saved or closed tabs have
  their backups deleted); versions are at least five minutes apart.
- **Spell checking** uses WebView2's dictionaries (Windows languages); there is no language choice in Kladde.
