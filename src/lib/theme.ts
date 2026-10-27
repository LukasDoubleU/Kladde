// Themes: the four Catppuccin flavors, the accent color and the user's theme.css.
//
// The colors themselves are CSS (src/themes.css), selected by `data-theme` and `data-accent` on the root
// element. This module decides which flavor applies, sets the attributes and loads theme.css, so switching
// is a handful of attribute writes and costs nothing at startup.

export const FLAVORS = ["mocha", "macchiato", "frappe", "latte"] as const;
export type Flavor = (typeof FLAVORS)[number];

export const ACCENTS = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender",
] as const;
export type Accent = (typeof ACCENTS)[number];

/** The `theme` setting. "dark" and "light" are the names from before the flavors: Mocha and Latte. */
export type ThemeSetting = Flavor | "system" | "dark" | "light";

/** Allowed values of the theme settings, to validate settings.json. */
export const THEME_CHOICES: Record<"theme" | "themeLight" | "themeDark" | "accent", readonly string[]> = {
  theme: [...FLAVORS, "system", "dark", "light"],
  themeLight: FLAVORS,
  themeDark: FLAVORS,
  accent: ACCENTS,
};

export const THEME_FILE = "theme.css";

/** Latte is the only light flavor; the native title bar and the Mermaid diagrams follow this. */
export const isLight = (flavor: Flavor) => flavor === "latte";

/** The flavor to show. "system" picks `themeLight` or `themeDark` by the Windows app mode. */
export function resolveFlavor(theme: string, themeLight: string, themeDark: string, systemDark: boolean): Flavor {
  const pick = (name: string, fallback: Flavor): Flavor =>
    (FLAVORS as readonly string[]).includes(name) ? (name as Flavor) : fallback;
  switch (theme) {
    case "system":
      return systemDark ? pick(themeDark, "mocha") : pick(themeLight, "latte");
    case "light":
      return "latte";
    case "dark":
      return "mocha";
    default:
      return pick(theme, "mocha");
  }
}

/** Switches flavor and accent. Listeners of "kladde-theme" (the Mermaid diagrams) redraw. */
export function applyTheme(flavor: Flavor, accent: string) {
  const root = document.documentElement;
  root.dataset.theme = flavor;
  root.dataset.accent = (ACCENTS as readonly string[]).includes(accent) ? accent : "rosewater";
  // Kept for stylesheets and the Mermaid theme that only care whether the flavor is dark.
  root.classList.toggle("dark", !isLight(flavor));
  window.dispatchEvent(new Event("kladde-theme"));
}

let userStyle: HTMLStyleElement | null = null;

/** Applies the text of theme.css (null: no file). It comes last in <head>, so it overrides the built-in theme. */
export function setUserTheme(css: string | null) {
  if (!css?.trim()) {
    userStyle?.remove();
    userStyle = null;
  } else {
    if (!userStyle) {
      userStyle = document.createElement("style");
      userStyle.id = "kladde-user-theme";
    }
    userStyle.textContent = css;
    // Appending again moves it to the end, after any stylesheet added since.
    document.head.append(userStyle);
  }
  window.dispatchEvent(new Event("kladde-theme"));
}

/** The variables a theme.css can set: the theming API, documented in the README. */
export const THEME_VARIABLES: { title: string; names: string[] }[] = [
  {
    title: "Palette: the Catppuccin colors. Everything below is built from these, so changing one retints the whole UI",
    names: [
      ...["rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach", "yellow", "green", "teal", "sky"],
      ...["sapphire", "blue", "lavender", "text", "subtext1", "subtext0", "overlay2", "overlay1", "overlay0"],
      ...["surface2", "surface1", "surface0", "base", "mantle", "crust", "accent"],
    ].map((n) => `--ctp-${n}`),
  },
  {
    title: "Interface and editor",
    names: [
      "bg", "bg-alt", "bg-hover", "fg", "fg-dim", "border", "accent", "accent-fg", "link", "caret", "selection",
      "selection-match", "active-line", "line-number", "active-line-number", "search-match", "search-match-border",
      "search-match-selected", "bracket-match", "special-char", "dirty", "error", "banner",
    ].map((n) => `--${n}`),
  },
  {
    title: "Compare view",
    names: ["del-bg", "del-text", "del-mark", "add-bg", "add-text", "add-mark"].map((n) => `--diff-${n}`),
  },
  {
    title: "Syntax highlighting (editor and code blocks in the preview)",
    names: [
      "keyword", "string", "escape", "number", "comment", "function", "type", "property", "variable", "operator",
      "punctuation", "meta", "heading", "link", "invalid", "inserted", "deleted", "date", "warn",
    ].map((n) => `--tok-${n}`),
  },
];

/** The text of a new theme.css: every variable, commented out, with its value in the current theme. */
export function userThemeTemplate(): string {
  const style = getComputedStyle(document.documentElement);
  const lines = [
    "/* Kladde custom theme. This file is loaded after the built-in theme, so it can override anything.",
    "   Saving it applies it immediately. Remove the comment marks around a line and change the color.",
    "   The values shown are those of the theme in use when this file was created. Fonts come from",
    "   settings.json (fontFamily, uiFontFamily). The README lists what each variable colors. */",
    "",
    ":root {",
  ];
  for (const group of THEME_VARIABLES) {
    lines.push(`  /* ${group.title} */`);
    for (const name of group.names) lines.push(`  /* ${name}: ${style.getPropertyValue(name).trim()}; */`);
    lines.push("");
  }
  lines.pop();
  lines.push("}", "");
  return lines.join("\n");
}
