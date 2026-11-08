# Product decisions

What Kladde should be, and choices the owner made on purpose. Keep them unless the owner says otherwise.

## What Kladde is

- "A text editor, simple yet powerful like Notepad++, without becoming an IDE."
- Single files in tabs. No project tree, no Git integration, no language servers, no autocompletion, no
  auto-closing brackets. Editors such as Zed or Kate were rejected as too IDE-like, Notepads as too minimal.
- Priorities, in this order: **zero data loss**, then **lightweight and fast**, then features.
- Opens anything: ~145 languages with highlighting, any encoding, binary-ish files, images, huge logs.
- Markdown with a live preview (images, diagrams, math) is a core feature, not an add-on.
- Windows only for now.

## Data safety

- Hot exit like Notepad++: closing the window never asks; everything, including unsaved text, comes back. Closing a
  single tab with unsaved changes does ask (Save / Don't save / Cancel).
- Unsaved text is backed up while typing (throttled), files are saved crash-safely, older backups are kept and can
  be restored into a new tab (never overwriting the current one).
- Files on disk are only written when the user saves, and saving a tab without changes writes nothing (like
  Notepad++): re-encoding unchanged text is not the identity (line breaks are normalized), so it would damage
  files that are not really text. A deleted file is the exception: saving recreates it.
- Binary and lossily decoded files (NUL byte, or invalid sequences in the encoding) open read-only with a banner
  and "Edit anyway"; the first save after that asks once. Protecting the bytes beats convenience: a .docx opened
  by mistake must survive `Ctrl+S`.

## Look and feel

- Theme: Catppuccin Mocha with Rosewater as accent is the default. All four Catppuccin flavors and 14 accents are
  available; the old hand-made light theme was replaced by Latte (`"light"` is an alias for Latte, `"dark"` for
  Mocha). Users can override any color in `theme.css`.
- Fonts: JetBrains Mono (with ligatures) in the editor, Inter for the UI, both bundled.
- Icon: a rosewater → maroon gradient tile with a dark notepad and rosewater lines (binding rings, three text
  lines; `assets/icon.svg`), because "Kladde" means scratch pad. It replaced a "K" with a cursor bar after v0.2.0,
  and pink and mauve gave way to rosewater after v0.6.0, both at the owner's request; at 16 px only the pad's
  outline and lines remain, which is enough. Regenerate the icon files with
  `npx tauri icon assets/icon.svg -o <temp dir>` and copy only the files already in `src-tauri/icons`.
- The search panel and every other piece of UI must follow the theme variables (no default browser controls).

## Keyboard

The default preset contains deliberate choices; presets (Notepad++, VS Code) and keybindings.json can change them.

- `Ctrl+D` = delete line (owner's choice; "select next occurrence" moved to `Ctrl+Shift+D`).
- `Alt+Shift+W` = reveal the current file in Explorer.
- Keys sent by the owner's mouse-gesture tool must work: `Ctrl+T` (new tab, besides `Ctrl+N`), `Ctrl+W` (close),
  `F5` (reload from disk), `Alt+Left` / `Alt+Right` (back/forward through recently used tabs, also on the mouse's
  back/forward buttons), `Ctrl+PageDown` / `Ctrl+PageUp` (next/previous tab, sent for right button + wheel), and
  `Alt+F4` closes the window via hot exit.
- `Ctrl+Alt+S` opens the settings page, because the owner is used to IntelliJ's key; "Save all" moved to `Ctrl+Alt+Shift+S`.
  The Notepad++ preset keeps `Ctrl+Alt+S` for "Save as" (as in Notepad++), so the settings page has no key there; the
  VS Code preset adds `Ctrl+,`. The command id `settings.open` (the JSON file) is unchanged.
- `Shift+Alt+F` formats by language; `Ctrl+Shift+V` cycles the Markdown preview; `F7`/`Shift+F7` move between
  changes in compare tabs; `Ctrl+Shift+P`/`F1` open the command palette, which lists every command with its keys;
  the owner also wants `Ctrl+Shift+A` (IntelliJ's "Find Action") and `Ctrl+3` (Eclipse's "Quick Access") for it.

## Documents

- **Word documents (`.docx`) open in a read-only viewer** (issue #22), as white pages on the themed background; editing,
  printing and searching inside are out of scope, as are `.doc`, `.docm`, `.dotx` and `.odt`. The tab kind is generic
  (`document`), so a PDF viewer can reuse it.
- **docx-preview over mammoth.** The spike compared both: mammoth turns a document into semantic HTML (fine for text,
  but headers, footers, page breaks, colors, shading and layout are gone), docx-preview keeps them and renders in
  ~0.1 s for a 50-page, 4.6 MB file. It costs ~180 kB (~54 kB gzip) loaded on first use, no startup cost and no CSP
  change. Its output is not re-colored with the theme (forcing Catppuccin colors onto it breaks documents): the pages
  are white (`--paper`), only the surroundings follow the theme.
- **No remote content, ever.** A document cannot load anything from the network (linked images, styles, fonts, VML
  backgrounds): the viewer removes every address that is not `data:` before attaching anything. This follows the
  privacy rule (nothing leaves the machine unless the user turns it on) and a document is a file from someone else.
- **Tracked changes and comments are shown**, as markup (insertions underlined, deletions struck through, comments as a
  marker with the text on hover), because the alternative (insertions as plain text, deletions and comments dropped) shows a
  text that is not what the file says.
- **Limits:** 50 MB; above it, encrypted or rights-managed files and damaged ones get a message with **Open in default
  app** and **Open as text** instead of a spinner or a crash.

## Privacy and the outside world

- Nothing leaves the machine unless the user turns it on. Grammar checking is off until toggled. Turning it on
  without a configured server offers (dialog) to **download** a local LanguageTool, to use the **public API** (one-time
  confirmation, a third party receives the text) or to cancel. A `languageToolServer` that is set (own server or the
  public API) always wins over the local one.
- **The local LanguageTool (issue #12, #18):** Kladde downloads, starts and stops it itself, so the user only flips a
  switch and, after the download, nothing leaves the machine. It is **never bundled** (the installer stays ~5 MB) and
  never fetched without a click. The download is the only network access besides the update check (GitHub) and the
  servers the user configured: LanguageTool 6.8, the standalone zip from Maven Central (permanent URLs,
  `https://repo1.maven.org/maven2/org/languagetool/languagetool-standalone/6.8/languagetool-standalone-6.8.zip`;
  SHA-256 `f04aecf37e35ef17d44b336da9668a5a3a871edd14bd83a766a7e110b9ebcd21`, 259 MB) and Eclipse Temurin JRE
  21.0.13+9 for Windows x64 from the adoptium GitHub releases (SHA-256
  `2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628`, 49 MB). URLs and hashes are constants in
  `src-tauri/src/lt_install.rs`; a file is hashed while it downloads and checked before anything is unpacked, a
  mismatch deletes it. The server listens on the loopback interface only, on a port Kladde picks; its process is
  tied to Kladde (see architecture.md). Upgrading LanguageTool or Java is a deliberate code change (new constants).
- Why Java and the real LanguageTool rather than a lighter engine: it is the one that checks German properly.
  Harper (Rust, tiny, instant) is a candidate for a future engine once it supports German.
- The update check (at start and every six hours, never more than once an hour, GitHub only) is on by default (`checkForUpdates`), and documented.
- Remote images in Markdown previews are allowed (https), local images load through the asset protocol.

## Windows integration

- Windows does not let apps make themselves the default silently. Kladde registers per user as a capable app for
  its file types ("Open with", Default apps page) and offers this once at start, dismissible for good; it never
  changes an existing default. An optional "Edit with Kladde" context-menu entry exists. Everything is undone by
  a command and by the uninstaller. Tauri's install-time `fileAssociations` are deliberately not used.
- The portable exe and the installed app behave the same; the updater installs only for the installed version and
  offers a download for the portable one.

## Releases

- Semantic Versioning and Conventional Commits; releases are created on demand (never on every push).
- v0.1.0 (2026-10-27) was the first public release; it has no updater, so v0.1.0 users must install the next
  release by hand once.
