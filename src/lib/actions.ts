// App-level commands and their keyboard shortcuts.
//
// Every command is an action with an id. Default shortcuts can be overridden in
// keybindings.json: { "file.save": "Ctrl+S", "view.togglePreview": ["Ctrl+K", "F8"], "file.close": null }

import { api } from "./api";

export interface Action {
  id: string;
  label: string;
  keys?: string[];
  run: () => unknown;
  /** Hides the action from the command palette and disables its shortcut when false. */
  enabled?: () => boolean;
}

export const KEYBINDINGS_FILE = "keybindings.json";

const actions = new Map<string, Action>();
let overrides: Record<string, string[] | null> = {};
let bindings = new Map<string, string>();

const ALIASES: Record<string, string> = {
  "+": "plus",
  "-": "minus",
  " ": "space",
  esc: "escape",
  del: "delete",
  pgup: "pageup",
  pgdn: "pagedown",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  control: "ctrl",
  cmd: "meta",
  win: "meta",
};

/** Normalizes "Ctrl+Shift+S" to "ctrl+shift+s" with a fixed modifier order. */
export function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim());
  const mods = new Set<string>();
  let key = "";
  for (const raw of parts) {
    const part = ALIASES[raw] ?? raw;
    if (part === "ctrl" || part === "alt" || part === "shift" || part === "meta") mods.add(part);
    else key = part;
  }
  return [...["ctrl", "alt", "shift", "meta"].filter((m) => mods.has(m)), key].join("+");
}

export function comboFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return null;
  let key: string;
  if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (e.key.length === 1) key = ALIASES[e.key] ?? e.key.toLowerCase();
  else key = e.key.toLowerCase();
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta"].filter(Boolean);
  return [...mods, key].join("+");
}

function keysOf(action: Action): string[] {
  const override = overrides[action.id];
  if (override === null) return [];
  return override ?? action.keys ?? [];
}

function rebuild() {
  bindings = new Map();
  for (const action of actions.values()) {
    for (const combo of keysOf(action)) bindings.set(normalizeCombo(combo), action.id);
  }
}

export function registerActions(list: Action[]) {
  for (const action of list) actions.set(action.id, action);
  rebuild();
}

export function allActions(): Action[] {
  return [...actions.values()].filter((a) => a.enabled?.() ?? true);
}

export function runAction(id: string) {
  const action = actions.get(id);
  if (action && (action.enabled?.() ?? true)) void action.run();
}

/** Human-readable shortcut of an action, e.g. "Ctrl+Shift+S". */
export function shortcutLabel(id: string): string {
  const action = actions.get(id);
  const first = action ? keysOf(action)[0] : undefined;
  if (!first) return "";
  return normalizeCombo(first)
    .split("+")
    .map((p) => (p === "plus" ? "+" : p === "minus" ? "-" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("+");
}

/** Runs the action bound to the pressed keys. Returns true if the event was handled. */
export function handleKeydown(e: KeyboardEvent): boolean {
  const combo = comboFromEvent(e);
  if (!combo) return false;
  const id = bindings.get(combo);
  const action = id ? actions.get(id) : undefined;
  if (!action || !(action.enabled?.() ?? true)) return false;
  e.preventDefault();
  e.stopPropagation();
  void action.run();
  return true;
}

export function defaultKeybindingsJson(): string {
  const entries = [...actions.values()]
    .filter((a) => a.keys?.length)
    .map((a) => `  ${JSON.stringify(a.id)}: ${JSON.stringify(a.keys!.length === 1 ? a.keys![0] : a.keys)}`);
  return `{\n${entries.join(",\n")}\n}\n`;
}

/** Loads keybindings.json. Returns an error message if the file is invalid. */
export async function loadKeybindings(): Promise<string | null> {
  const text = await api.configRead(KEYBINDINGS_FILE);
  overrides = {};
  let error: string | null = null;
  if (text) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const [id, value] of Object.entries(parsed)) {
        if (value === null) overrides[id] = null;
        else if (typeof value === "string") overrides[id] = [value];
        else if (Array.isArray(value)) overrides[id] = value.filter((v): v is string => typeof v === "string");
      }
    } catch (e) {
      error = `keybindings.json is not valid JSON: ${e}`;
    }
  }
  rebuild();
  return error;
}
