# Roadmap and known gaps

State after v0.2.0 (end of October 2026). Issues #1–#8, #10 and #11 are closed.

## Open issues

### #9 Code signing
Auto-update is done. Missing: Authenticode signing so SmartScreen does not warn. Options: Azure Artifact Signing
(formerly Trusted Signing) or SignPath Foundation (free for open source, manual application). Wire it in through
Tauri's `bundle.windows.signCommand` (signs exe, installer and uninstaller during the build; the portable exe is a
copy of the signed `kladde.exe`). The updater's minisign `.sig` must be created after Authenticode signing.

## Smaller follow-ups (no issues yet)

- **Large files (editing, #5):** the viewer is a real editor now (piece table, journal, streaming save; see
  [architecture.md](architecture.md)). Known gaps:
  - Editing needs the line index to be complete (seconds for multi-GB files); typing before that shows a notice.
  - No find-and-replace and no multi-cursor in the large view; only the editor commands in `LARGE_COMMANDS` work.
  - Lines longer than 64 KB are shown cut; editing them works (Rust clamps columns to the real line end), but
    the cut part cannot be seen or selected with the mouse.
  - Saving needs the original unchanged: a rewritten or truncated original blocks saving (the edits stay in the
    journal; reload to discard them). An original that only grew is saved with the appended bytes after the
    document.
  - While a large tab has unsaved edits, other programs cannot write the file (a logger writing to it would
    fail); if one has the file open already, the handle cannot be taken and the save-time check applies.
  - A journal whose file has vanished is not restored (the edits need the original); the next session save
    prunes it.
  - Text tabs have a small window that large tabs no longer have: a crash between writing a backup and
    `session.json` leaves a session file without `hasBackup`, so the backup is not restored (large tabs ask
    Rust for a journal regardless).
  - The undo history is lost when the tab is saved (the viewer continues on a new file) and is not part of
    the journal.
  - Search limits: a match cannot span chunks (~8 MB, 64 KB overlap inside very long lines); a regex match
    over a line break is highlighted on its first line only.
- **Grammar (LanguageTool):** keyboard access to findings (F8 / `lintKeymap`, apply fix by key); persistent "ignore
  word/rule" (a user dictionary); the public-API consent lives in WebView `localStorage` instead of the data folder;
  auto-detection is weak on very short paragraphs.
  - Local LanguageTool (#18, done): the e2e tests use a stand-in server and small zips; the real downloads were only
    run by hand (numbers in architecture.md). The pinned LanguageTool 6.6 comes from `languagetool.org/download/`,
    which holds the current release: when a newer one is published the file moves and the pinned URL may stop
    working (the hash would catch a changed file), so the constants need a bump then (see development.md). No
    resume of an interrupted download, no ngram data (the confusion-word rules), no fastText model (language
    detection uses LanguageTool's built-in one), no choice of the heap size.
  - **Harper** (Rust, no JVM, instant) as an additional, much lighter engine once it supports German; the local
    LanguageTool stays the engine for German until then.
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
