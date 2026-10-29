// Keymap presets: the `keymap` setting picks one as the base for the shortcuts, and keybindings.json
// overrides single commands on top of it. The built-in defaults (the `keys` of each action) are the
// "default" preset; the others only list what differs. Listing a command with `[]` unbinds it.
//
// Sources: the Notepad++ list is its stock shortcut table (Parameters.cpp, `winKeyDefs` and
// `scintKeyDefs`); the VS Code list is its default Windows keybindings.

export type KeymapName = "default" | "notepad++" | "vscode";

export interface Keymap {
  label: string;
  description: string;
  /** Command id -> keys, replacing the built-in default of that command. */
  keys: Record<string, string[]>;
}

export const KEYMAPS: Record<KeymapName, Keymap> = {
  default: {
    label: "Kladde",
    description: "VS Code and CodeMirror keys, plus Ctrl+T, F5 and Alt+Left / Alt+Right for mouse gestures",
    keys: {},
  },
  "notepad++": {
    label: "Notepad++",
    description: "Ctrl+D duplicates a line, Ctrl+Shift+L deletes it, Ctrl+Shift+Up / Down move lines, Ctrl+Q comments",
    // Kept from the default on purpose, although Notepad++ differs: Ctrl+T (new tab, instead of transposing
    // lines), F5 (reload, instead of Run) and Alt+Left / Alt+Right, because mouse gesture tools send them.
    keys: {
      "edit.deleteLine": ["Ctrl+Shift+L"],
      "editor.cutLine": ["Ctrl+L"],
      "editor.duplicateLine": ["Ctrl+D"],
      "editor.moveLineUp": ["Ctrl+Shift+Up"],
      "editor.moveLineDown": ["Ctrl+Shift+Down"],
      "editor.joinLines": ["Ctrl+J"],
      "editor.insertBlankLine": ["Ctrl+Alt+Shift+Enter"],
      "editor.toggleComment": ["Ctrl+Q"],
      "editor.toggleBlockComment": ["Ctrl+Shift+Q"],
      "editor.lineComment": ["Ctrl+K"],
      "editor.lineUncomment": ["Ctrl+Shift+K"],
      "editor.toUpperCase": ["Ctrl+Shift+U"],
      "editor.toLowerCase": ["Ctrl+U"],
      "editor.cursorMatchingBracket": ["Ctrl+B"],
      "editor.foldAll": ["Alt+0"],
      "editor.unfoldAll": ["Alt+Shift+0"],
      // Ctrl+Shift+L is "delete line" in Notepad++.
      "editor.selectAllOccurrences": [],
      "file.reload": ["Ctrl+R", "F5"],
      "file.saveAs": ["Ctrl+Alt+S"],
      "file.saveAll": ["Ctrl+Shift+S"],
      // Ctrl+Alt+S is "save as" in Notepad++, so the settings page has no key here.
      "settings.show": [],
    },
  },
  vscode: {
    label: "VS Code",
    description: "Ctrl+D selects the next occurrence, Ctrl+Shift+K deletes a line, Ctrl+K chords like Ctrl+K Ctrl+C",
    keys: {
      "edit.deleteLine": ["Ctrl+Shift+K"],
      "editor.selectNextOccurrence": ["Ctrl+D"],
      "editor.selectLine": ["Ctrl+L"],
      "editor.lineComment": ["Ctrl+K Ctrl+C"],
      "editor.lineUncomment": ["Ctrl+K Ctrl+U"],
      "editor.foldAll": ["Ctrl+K Ctrl+0"],
      "editor.unfoldAll": ["Ctrl+K Ctrl+J"],
      "editor.trimTrailingWhitespace": ["Ctrl+K Ctrl+X"],
      // Ctrl+J toggles the panel in VS Code; joining lines has no key there.
      "editor.joinLines": [],
      "view.togglePreview": ["Ctrl+Shift+V", "Ctrl+K V"],
      "keybindings.change": ["Ctrl+K Ctrl+S"],
      // Added to the default key (IntelliJ's), which VS Code does not use.
      "settings.show": ["Ctrl+,", "Ctrl+Alt+S"],
    },
  },
};

/** Looks up a preset by the value of the `keymap` setting (forgiving about case and spelling). */
export function keymapNamed(name: unknown): KeymapName | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (key === "default" || key === "kladde") return "default";
  if (key === "notepad++" || key === "notepadpp" || key === "npp") return "notepad++";
  if (key === "vscode" || key === "code") return "vscode";
  return null;
}
