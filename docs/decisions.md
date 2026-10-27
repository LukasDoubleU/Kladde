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
- Files on disk are only written when the user saves.

## Look and feel

- Theme: Catppuccin Mocha with Rosewater as accent is the default. All four Catppuccin flavors and 14 accents are
  available; the old hand-made light theme was replaced by Latte (`"light"` is an alias for Latte, `"dark"` for
  Mocha). Users can override any color in `theme.css`.
- Fonts: JetBrains Mono (with ligatures) in the editor, Inter for the UI, both bundled.
- Icon: a rosewater → pink → mauve gradient tile with a dark "K" and a cursor bar (`assets/icon.svg`). Chosen
  because it stays recognizable at 16 px; a notebook design lost its details at small sizes.
- The search panel and every other piece of UI must follow the theme variables (no default browser controls).

## Keyboard

The default preset contains deliberate choices; presets (Notepad++, VS Code) and keybindings.json can change them.

- `Ctrl+D` = delete line (owner's choice; "select next occurrence" moved to `Ctrl+Shift+D`).
- `Alt+Shift+W` = reveal the current file in Explorer.
- Keys sent by the owner's mouse-gesture tool must work: `Ctrl+T` (new tab, besides `Ctrl+N`), `Ctrl+W` (close),
  `F5` (reload from disk), `Alt+Left` / `Alt+Right` (back/forward through recently used tabs, also on the mouse's
  back/forward buttons), `Ctrl+PageDown` / `Ctrl+PageUp` (next/previous tab, sent for right button + wheel), and
  `Alt+F4` closes the window via hot exit.
- `Shift+Alt+F` formats by language; `Ctrl+Shift+V` cycles the Markdown preview; `F7`/`Shift+F7` move between
  changes in compare tabs; `Ctrl+Shift+P`/`F1` open the command palette, which lists every command with its keys.

## Privacy and the outside world

- Nothing leaves the machine unless the user turns it on: LanguageTool needs a configured server and an explicit
  toggle; the public LanguageTool API asks for a one-time confirmation.
- The update check (once a day, GitHub only) is on by default (`checkForUpdates`), and documented.
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
