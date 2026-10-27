// App-level commands and their keyboard shortcuts.
//
// Every command is an action with an id. The keys of an action come from three layers, and the highest
// one that mentions the action wins: keybindings.json, the keymap preset (setting `keymap`), the `keys`
// of the action itself. A key is a combo ("Ctrl+S") or a chord of several ("Ctrl+K Ctrl+C"). Example:
// { "file.save": "Ctrl+S", "view.togglePreview": ["Ctrl+Shift+V", "Ctrl+K V"], "file.close": null }

import { api } from "./api";
import { KEYMAPS, keymapNamed, type KeymapName } from "./keymaps";
import {
  BUILTIN_KEYS,
  comboFromEvent,
  formatSequence,
  normalizeSequence,
  resolveBindings,
  sequencesConflict,
  type BindingEntry,
  type ResolvedBindings,
} from "./keys";

export { comboFromEvent, normalizeCombo, normalizeSequence } from "./keys";

export interface Action {
  id: string;
  label: string;
  keys?: string[];
  run: () => unknown;
  /** Hides the action from the command palette and disables its shortcut when false. */
  enabled?: () => boolean;
}

export const KEYBINDINGS_FILE = "keybindings.json";

/** How long a chord waits for its next key. */
const CHORD_TIMEOUT = 2000;

const actions = new Map<string, Action>();
let overrides: Record<string, string[] | null> = {};
let keymapName: KeymapName = "default";
let resolved: ResolvedBindings = { bindings: new Map(), prefixes: new Set(), keys: new Map() };

/** The override of an action, unless it only repeats the built-in default under another preset. */
function overrideOf(action: Action): string[] | null | undefined {
  const override = overrides[action.id];
  // keybindings.json files written by older versions listed every default; they must not pin the
  // default keys when a preset is chosen.
  if (override && keymapName !== "default" && action.id in KEYMAPS[keymapName].keys) {
    const same = (a: string[], b: string[]) => a.map(normalizeSequence).join("|") === b.map(normalizeSequence).join("|");
    if (same(override, action.keys ?? [])) return undefined;
  }
  return override;
}

/** Keys of an action without keybindings.json: the preset's, or its own default. */
export function defaultKeysOf(id: string): string[] {
  return KEYMAPS[keymapName].keys[id] ?? actions.get(id)?.keys ?? [];
}

function rebuild() {
  const entries: BindingEntry[] = [];
  for (const action of actions.values()) {
    const override = overrideOf(action);
    const layer = override !== undefined ? 2 : action.id in KEYMAPS[keymapName].keys ? 1 : 0;
    for (const key of override !== undefined ? (override ?? []) : defaultKeysOf(action.id)) {
      const seq = normalizeSequence(key);
      if (seq) entries.push({ id: action.id, seq, layer });
    }
  }
  resolved = resolveBindings(entries);
  cancelChord();
}

export function registerActions(list: Action[]) {
  for (const action of list) actions.set(action.id, action);
  rebuild();
}

/** Chooses the keymap preset by the value of the `keymap` setting. Unknown names mean the default. */
export function setKeymap(name: unknown) {
  const next = keymapNamed(name) ?? "default";
  if (next === keymapName) return;
  keymapName = next;
  rebuild();
}

export function currentKeymap(): KeymapName {
  return keymapName;
}

/** The actions that are available right now (the command palette). */
export function allActions(): Action[] {
  return [...actions.values()].filter((a) => a.enabled?.() ?? true);
}

/** Every action, also those that are disabled at the moment (the shortcut editor). */
export function registeredActions(): Action[] {
  return [...actions.values()];
}

export function runAction(id: string) {
  const action = actions.get(id);
  if (action && (action.enabled?.() ?? true)) void action.run();
}

/** The keys an action really has, normalized, e.g. ["ctrl+k ctrl+c"]. */
export function keysOf(id: string): string[] {
  return resolved.keys.get(id) ?? [];
}

/** Human-readable shortcut of an action, e.g. "Ctrl+Shift+S" or "Ctrl+K Ctrl+C". */
export function shortcutLabel(id: string): string {
  const first = keysOf(id)[0];
  return first ? formatSequence(first) : "";
}

/** The other actions that use a key sequence, a chord starting with it, or the start of it. */
export function findConflicts(sequence: string, exceptId: string): { id: string; label: string; key: string }[] {
  const seq = normalizeSequence(sequence);
  const found: { id: string; label: string; key: string }[] = [];
  for (const [id, keys] of resolved.keys) {
    if (id === exceptId) continue;
    for (const key of keys) {
      if (sequencesConflict(key, seq)) found.push({ id, label: actions.get(id)?.label ?? id, key });
    }
  }
  return found;
}

/** Name of the fixed editing command (not an action) that has this key, if any. */
export function builtinKeyName(sequence: string): string | null {
  return BUILTIN_KEYS[normalizeSequence(sequence)] ?? null;
}

// ---------------------------------------------------------------- key handling

let pending = "";
let pendingTimer = 0;
let flashTimer = 0;
let hintListener: (text: string) => void = () => {};

/** Receives the text for the status bar while a chord waits for its next key ("" when it is over). */
export function setChordHintListener(listener: (text: string) => void) {
  hintListener = listener;
}

function cancelChord() {
  clearTimeout(pendingTimer);
  if (pending) {
    pending = "";
    hintListener("");
  }
}

function startChord(sequence: string) {
  clearTimeout(pendingTimer);
  clearTimeout(flashTimer);
  pending = sequence;
  const second = sequence.split(" ").length === 1;
  hintListener(`${formatSequence(sequence)} pressed, waiting for the ${second ? "second" : "next"} key…`);
  pendingTimer = window.setTimeout(cancelChord, CHORD_TIMEOUT);
}

function flashHint(text: string) {
  hintListener(text);
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => hintListener(""), 1500);
}

/** Runs the action bound to the pressed keys. Returns true if the event was handled. */
export function handleKeydown(e: KeyboardEvent): boolean {
  // Typing is the common case: keep it out of everything below.
  if (!pending && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) return false;
  const combo = comboFromEvent(e);
  // A bare modifier (the Ctrl of "Ctrl+K Ctrl+C") leaves a waiting chord alone.
  if (!combo) return false;
  const swallow = () => {
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  const waiting = pending;
  if (waiting && combo === "escape") {
    cancelChord();
    return swallow();
  }
  const sequence = waiting ? `${waiting} ${combo}` : combo;
  cancelChord();
  // A key that starts a chord never runs on its own: resolveBindings() allows no such binding.
  if (resolved.prefixes.has(sequence)) {
    startChord(sequence);
    return swallow();
  }
  const id = resolved.bindings.get(sequence);
  const action = id ? actions.get(id) : undefined;
  if (action && (action.enabled?.() ?? true)) {
    void action.run();
    return swallow();
  }
  if (waiting) {
    flashHint(`${formatSequence(sequence)} is not a command.`);
    return swallow();
  }
  return false;
}

/** Contents of a new keybindings.json: nothing is overridden, so the keymap preset applies in full. */
export function defaultKeybindingsJson(): string {
  return "{\n}\n";
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
