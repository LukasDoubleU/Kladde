// The settings: their type, their defaults and what the settings page needs to show them (group, label,
// description, control). It is a plain module (no runes) so that Node's unit tests can load it; the reactive
// store and the reading and writing of settings.json are in settings.svelte.ts.
import { LANGUAGES } from "./grammar-text.ts";
import { KEYMAPS, type KeymapName } from "./keymaps.ts";
import { ACCENTS, type Accent, FLAVORS, type Flavor, type ThemeSetting } from "./theme.ts";

export interface Settings {
  /** Editor font. JetBrains Mono and Inter are bundled, so the defaults work without installing them. */
  fontFamily: string;
  fontSize: number;
  /** Programming ligatures such as => and != (if the font has them). */
  fontLigatures: boolean;
  uiFontFamily: string;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  highlightActiveLine: boolean;
  /** Spell checking with the Windows dictionaries; toggled per session with the command palette. */
  spellCheck: boolean;
  /** A Catppuccin flavor, or "system" to follow Windows. "dark" and "light" are the old names of Mocha and Latte. */
  theme: ThemeSetting;
  /** Flavor for "system" while Windows is in light mode. */
  themeLight: Flavor;
  /** Flavor for "system" while Windows is in dark mode. */
  themeDark: Flavor;
  /** Catppuccin accent color: selections, caret, focus rings, buttons. */
  accent: Accent;
  /** Grammar checking with LanguageTool at start; toggled per session with the command palette. */
  grammarCheck: boolean;
  /** Address of a LanguageTool server; empty means the local LanguageTool that Kladde manages itself. */
  languageToolServer: string;
  /** "auto" detects the language per paragraph, or a code such as "de-DE". */
  languageToolLanguage: string;
  /** Variants LanguageTool should prefer when it detects the language itself. */
  languageToolVariants: string;
  /** Check every file type, not only Markdown and plain text. */
  languageToolAllFiles: boolean;
  /** Files above this size open in the read-only large file viewer. */
  largeFileThresholdMB: number;
  /** How Markdown files open: source only, side by side, or rendered only. */
  markdownPreview: "off" | "split" | "only";
  /** Folder (relative to the Markdown file) for images pasted from the clipboard. */
  pasteImageFolder: string;
  /** Base for the keyboard shortcuts: "default", "notepad++" or "vscode"; keybindings.json overrides single commands. */
  keymap: "default" | "notepad++" | "vscode";
  /** Offer once at start to make Kladde selectable as the default editor in Windows. */
  offerDefaultEditor: boolean;
  /** Look for a newer version on GitHub a few seconds after start and every six hours while Kladde is open. */
  checkForUpdates: boolean;
}

export const defaultSettings: Settings = {
  fontFamily: "'JetBrains Mono', 'JetBrains Mono Variable', Consolas, monospace",
  fontSize: 14,
  fontLigatures: true,
  uiFontFamily: "Inter, 'Inter Variable', 'Segoe UI', sans-serif",
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  lineNumbers: true,
  highlightActiveLine: true,
  spellCheck: false,
  theme: "mocha",
  themeLight: "latte",
  themeDark: "mocha",
  accent: "rosewater",
  grammarCheck: false,
  languageToolServer: "",
  languageToolLanguage: "auto",
  languageToolVariants: "en-US,de-DE",
  languageToolAllFiles: false,
  largeFileThresholdMB: 32,
  markdownPreview: "split",
  pasteImageFolder: "assets",
  keymap: "default",
  offerDefaultEditor: true,
  checkForUpdates: true,
};

// ---------------------------------------------------------------- what the settings page shows

/** The sections of the settings page, in this order. */
export const SETTING_GROUPS = [
  { id: "editor", label: "Editor" },
  { id: "appearance", label: "Appearance" },
  { id: "preview", label: "Markdown preview" },
  { id: "large", label: "Large files" },
  { id: "keys", label: "Keyboard" },
  { id: "spelling", label: "Spelling and grammar" },
  { id: "updates", label: "Updates" },
  { id: "windows", label: "Windows integration" },
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number]["id"];

export interface Choice {
  value: string;
  label: string;
}

export type SettingControl =
  | { type: "boolean" }
  | { type: "number"; min: number; max: number; unit?: string }
  | { type: "choice"; choices: readonly Choice[] }
  | { type: "text"; placeholder?: string };

export interface SettingMeta {
  group: SettingGroup;
  label: string;
  description: string;
  control: SettingControl;
}

const capitalized = (name: string) => name[0].toUpperCase() + name.slice(1);
const named = (names: readonly string[]): Choice[] => names.map((value) => ({ value, label: capitalized(value) }));

/**
 * One entry per setting, in the order the page lists them within a group. The type makes a missing entry a
 * compile error, and tests/unit/settings.test.mjs checks that the controls fit the defaults, so a new setting
 * cannot be forgotten here.
 */
export const SETTING_META: Record<keyof Settings, SettingMeta> = {
  fontFamily: {
    group: "editor",
    label: "Editor font",
    description: "Font family of the text. JetBrains Mono is bundled; an installed font of that name is preferred.",
    control: { type: "text" },
  },
  fontSize: {
    group: "editor",
    label: "Font size",
    description: "Size of the text in pixels. Ctrl+Plus, Ctrl+Minus and Ctrl+wheel zoom on top of it.",
    control: { type: "number", min: 6, max: 72, unit: "px" },
  },
  fontLigatures: {
    group: "editor",
    label: "Ligatures",
    description: "Draw => and != as single symbols, if the font has them.",
    control: { type: "boolean" },
  },
  tabSize: {
    group: "editor",
    label: "Tab size",
    description: "Width of a tab character, and how many spaces one indentation level inserts.",
    control: { type: "number", min: 1, max: 16, unit: "columns" },
  },
  insertSpaces: {
    group: "editor",
    label: "Indent with spaces",
    description: "The Tab key and indentation commands insert spaces instead of tab characters.",
    control: { type: "boolean" },
  },
  wordWrap: {
    group: "editor",
    label: "Word wrap",
    description: "Wrap long lines at the window edge. Alt+Z toggles it for the session.",
    control: { type: "boolean" },
  },
  lineNumbers: {
    group: "editor",
    label: "Line numbers",
    description: "Show the line number gutter.",
    control: { type: "boolean" },
  },
  highlightActiveLine: {
    group: "editor",
    label: "Highlight the current line",
    description: "Give the line with the cursor a background.",
    control: { type: "boolean" },
  },

  theme: {
    group: "appearance",
    label: "Theme",
    description: "A Catppuccin flavor, or follow the Windows light or dark mode (then the two flavors below apply).",
    control: {
      type: "choice",
      choices: [...named(FLAVORS), { value: "system", label: "Follow Windows" }],
    },
  },
  themeLight: {
    group: "appearance",
    label: "Flavor in light mode",
    description: "The flavor used while Windows is in light mode and the theme is “Follow Windows”.",
    control: { type: "choice", choices: named(FLAVORS) },
  },
  themeDark: {
    group: "appearance",
    label: "Flavor in dark mode",
    description: "The flavor used while Windows is in dark mode and the theme is “Follow Windows”.",
    control: { type: "choice", choices: named(FLAVORS) },
  },
  accent: {
    group: "appearance",
    label: "Accent color",
    description: "Selections, the caret, focus rings and buttons.",
    control: { type: "choice", choices: named(ACCENTS) },
  },
  uiFontFamily: {
    group: "appearance",
    label: "Interface font",
    description: "Font family of menus, tabs, dialogs and the preview. Inter is bundled.",
    control: { type: "text" },
  },

  markdownPreview: {
    group: "preview",
    label: "Markdown preview",
    description: "How Markdown files open. Ctrl+Shift+V cycles through the modes per tab.",
    control: {
      type: "choice",
      choices: [
        { value: "split", label: "Side by side" },
        { value: "only", label: "Preview only" },
        { value: "off", label: "Source only" },
      ],
    },
  },
  pasteImageFolder: {
    group: "preview",
    label: "Folder for pasted images",
    description: "Where an image pasted into a saved Markdown file is written, relative to that file.",
    control: { type: "text", placeholder: "assets" },
  },

  largeFileThresholdMB: {
    group: "large",
    label: "Large file threshold",
    description: "Files above this size open in the large file view, which loads only the visible part.",
    control: { type: "number", min: 1, max: 4096, unit: "MB" },
  },

  keymap: {
    group: "keys",
    label: "Shortcut preset",
    description: "The base for the keyboard shortcuts; keybindings.json overrides single commands on top of it.",
    control: {
      type: "choice",
      choices: (Object.keys(KEYMAPS) as KeymapName[]).map((value) => ({ value, label: KEYMAPS[value].label })),
    },
  },

  spellCheck: {
    group: "spelling",
    label: "Spell checking",
    description: "Underline misspelled words with the Windows dictionaries. The command palette toggles it for the session.",
    control: { type: "boolean" },
  },
  grammarCheck: {
    group: "spelling",
    label: "Grammar checking",
    description: "Check grammar with LanguageTool at start. Without a server below, Kladde offers to download its own LanguageTool the first time.",
    control: { type: "boolean" },
  },
  languageToolServer: {
    group: "spelling",
    label: "LanguageTool server",
    description: "Address of a LanguageTool server of your own, or the public API (https://api.languagetool.org, a third party that receives your text). Empty means the local LanguageTool that Kladde downloads, starts and stops itself.",
    control: { type: "text", placeholder: "http://localhost:8081" },
  },
  languageToolLanguage: {
    group: "spelling",
    label: "Grammar language",
    description: "The language to check, or detect it per paragraph. A code such as fr-CA can be set in settings.json.",
    control: { type: "choice", choices: LANGUAGES.map((l) => ({ value: l.id, label: l.label })) },
  },
  languageToolVariants: {
    group: "spelling",
    label: "Preferred variants",
    description: "Variants LanguageTool prefers when it detects the language itself (en can be US or UK), separated by commas.",
    control: { type: "text", placeholder: "en-US,de-DE" },
  },
  languageToolAllFiles: {
    group: "spelling",
    label: "Check all file types",
    description: "Check every text file, not only Markdown and plain text.",
    control: { type: "boolean" },
  },

  checkForUpdates: {
    group: "updates",
    label: "Check for updates",
    description: "Look for a newer version on GitHub a few seconds after start and every six hours while Kladde is open (never more than once an hour). The command and the Check now button on this page work either way.",
    control: { type: "boolean" },
  },

  offerDefaultEditor: {
    group: "windows",
    label: "Offer to become a default editor",
    description: "Offer once at start to register Kladde as a candidate for opening file types.",
    control: { type: "boolean" },
  },
};

/** The names of all settings in the order of the page (group by group). */
export function settingNames(): (keyof Settings)[] {
  const names = Object.keys(SETTING_META) as (keyof Settings)[];
  const rank = (name: keyof Settings) => SETTING_GROUPS.findIndex((g) => g.id === SETTING_META[name].group);
  return names.sort((a, b) => rank(a) - rank(b));
}

/** Whether a setting matches a search (every word must): its label, description, name, section and the labels of its choices. */
export function settingMatches(name: keyof Settings, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const meta = SETTING_META[name];
  const choices = meta.control.type === "choice" ? meta.control.choices.map((c) => c.label).join(" ") : "";
  const group = SETTING_GROUPS.find((g) => g.id === meta.group)!.label;
  const haystack = `${meta.label} ${meta.description} ${name} ${group} ${choices}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** A value from the page's control brought into the setting's range and type; null if it is not usable. */
export function coerceSetting(name: keyof Settings, raw: unknown): Settings[keyof Settings] | null {
  const control = SETTING_META[name].control;
  switch (control.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : null;
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return null;
      return Math.min(control.max, Math.max(control.min, Math.round(n)));
    }
    case "choice":
      return typeof raw === "string" && control.choices.some((c) => c.value === raw) ? (raw as Settings[keyof Settings]) : null;
    case "text":
      return typeof raw === "string" ? raw.trim() : null;
  }
}
