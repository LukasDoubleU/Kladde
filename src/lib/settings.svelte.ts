// User settings, read from settings.json in the app's config folder.
import { api } from "./api";
import { type Accent, type Flavor, THEME_CHOICES, type ThemeSetting } from "./theme";

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
  /** Look for a newer version on GitHub a few seconds after start, at most once a day. */
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
  largeFileThresholdMB: 32,
  markdownPreview: "split",
  pasteImageFolder: "assets",
  keymap: "default",
  offerDefaultEditor: true,
  checkForUpdates: true,
};

export const SETTINGS_FILE = "settings.json";

export const settings: Settings = $state({ ...defaultSettings });

/** Loads settings.json over the defaults. Returns an error message if the file is invalid. */
export async function loadSettings(): Promise<string | null> {
  const text = await api.configRead(SETTINGS_FILE);
  const next = { ...defaultSettings };
  let error: string | null = null;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
        if (key in parsed && typeof parsed[key] === typeof defaultSettings[key]) {
          (next as Record<string, unknown>)[key] = parsed[key];
        }
      }
    } catch (e) {
      error = `settings.json is not valid JSON: ${e}`;
    }
  }
  // A typo in a theme name must not leave the app without a theme.
  const unknown: string[] = [];
  for (const [key, allowed] of Object.entries(THEME_CHOICES)) {
    const name = key as keyof typeof THEME_CHOICES;
    if (!allowed.includes(next[name])) {
      unknown.push(`${key} "${next[name]}"`);
      (next as Record<string, unknown>)[name] = defaultSettings[name];
    }
  }
  if (unknown.length) error = `${error ? error + " " : ""}Unknown ${unknown.join(", ")}: using the default.`;
  Object.assign(settings, next);
  return error;
}

export function defaultSettingsJson(): string {
  return JSON.stringify(defaultSettings, null, 2) + "\n";
}
