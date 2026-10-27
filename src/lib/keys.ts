// Key combinations and sequences ("chords"): parsing, matching and display. No imports, so the
// unit tests can load it directly.
//
// A combo is "Ctrl+Shift+S"; a sequence is one or more combos separated by spaces: "Ctrl+K Ctrl+C".
// Internally both are normalized to lower case with a fixed modifier order ("ctrl+shift+s").

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

const MODIFIERS = ["ctrl", "alt", "shift", "meta"];

/** Normalizes "Ctrl+Shift+S" to "ctrl+shift+s". Returns "" if there is no key. */
export function normalizeCombo(combo: string): string {
  let text = combo.trim().toLowerCase();
  if (text === "+") text = "plus";
  else text = text.replace(/\+\+$/, "+plus");
  const mods = new Set<string>();
  let key = "";
  for (const raw of text.split("+").map((p) => p.trim())) {
    const part = ALIASES[raw] ?? raw;
    if (MODIFIERS.includes(part)) mods.add(part);
    else key = part;
  }
  if (!key) return "";
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

/** Normalizes "Ctrl+K Ctrl+C" to "ctrl+k ctrl+c". Returns "" if any part is invalid. */
export function normalizeSequence(sequence: string): string {
  const parts = sequence
    .replace(/\s*\+\s*(?=\S)/g, "+")
    .trim()
    .split(/\s+/)
    .map(normalizeCombo);
  return parts.length && parts.every(Boolean) ? parts.join(" ") : "";
}

// Keys whose character changes with Shift on most layouts: match them by the unshifted symbol, so
// "Ctrl+Shift+[" works although the event says "{". Letters of other layouts (ü, ö) are left alone.
const SHIFTED_PUNCTUATION: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Backquote: "`",
};

/** The normalized combo of a key event, or null for a bare modifier key (and AltGr characters). */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta" || e.key === "AltGraph") return null;
  // AltGr reports Ctrl+Alt and types a character on many layouts (@, [, {): never a shortcut.
  if (e.ctrlKey && e.altKey && e.getModifierState?.("AltGraph")) return null;
  let key: string;
  if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (e.shiftKey && e.key.length === 1 && SHIFTED_PUNCTUATION[e.code] && !/[\p{L}\p{N}]/u.test(e.key)) {
    key = SHIFTED_PUNCTUATION[e.code];
  } else if (e.key.length === 1) key = ALIASES[e.key] ?? e.key.toLowerCase();
  else key = e.key.toLowerCase();
  let combo = "";
  if (e.ctrlKey) combo += "ctrl+";
  if (e.altKey) combo += "alt+";
  if (e.shiftKey) combo += "shift+";
  if (e.metaKey) combo += "meta+";
  return combo + key;
}

const DISPLAY: Record<string, string> = {
  plus: "+",
  minus: "-",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** "ctrl+shift+s" -> "Ctrl+Shift+S". */
export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => DISPLAY[p] ?? p.charAt(0).toUpperCase() + p.slice(1))
    .join("+");
}

/** "ctrl+k ctrl+c" -> "Ctrl+K Ctrl+C" (accepts unnormalized input). */
export function formatSequence(sequence: string): string {
  const normalized = normalizeSequence(sequence);
  return normalized ? normalized.split(" ").map(formatCombo).join(" ") : sequence;
}

/** True if both sequences cannot be bound at once: they are equal, or one starts the other. */
export function sequencesConflict(a: string, b: string): boolean {
  return a === b || a.startsWith(b + " ") || b.startsWith(a + " ");
}

/** Keys with a fixed meaning in the editor that are not actions: rebinding one takes it away. */
export const BUILTIN_KEYS: Record<string, string> = {
  "ctrl+z": "Undo",
  "ctrl+y": "Redo",
  "ctrl+shift+z": "Redo",
  "ctrl+a": "Select all",
  "ctrl+c": "Copy",
  "ctrl+x": "Cut",
  "ctrl+v": "Paste",
  "ctrl+backspace": "Delete word",
  "ctrl+delete": "Delete word",
};

/**
 * Whether a combo may start a binding: it must not be a plain typing key. Letters, digits, Enter,
 * Tab and so on need Ctrl, Alt or Win; function keys work alone. Later steps of a chord may be any key.
 */
export function isShortcutStart(combo: string): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  if (parts.some((p) => p === "ctrl" || p === "alt" || p === "meta")) return true;
  return /^f([1-9]|1\d|2[0-4])$/.test(key);
}

export interface BindingEntry {
  id: string;
  /** Normalized sequence. */
  seq: string;
  /** 0 = built-in default, 1 = preset, 2 = keybindings.json. */
  layer: number;
}

export interface ResolvedBindings {
  /** Sequence -> action id. */
  bindings: Map<string, string>;
  /** Every proper prefix of a bound chord ("ctrl+k"). */
  prefixes: Set<string>;
  /** Action id -> its bindings that survived, in the order given. */
  keys: Map<string, string[]>;
}

/**
 * Picks the bindings that stay when several actions claim the same keys. A higher layer beats a lower
 * one (so a preset or keybindings.json frees a default key), within a layer the longer sequence wins
 * (a chord beats a single key it starts with), then the later entry. A key and a chord starting with it
 * never coexist, since the first key would have to run and wait at once.
 */
export function resolveBindings(entries: BindingEntry[]): ResolvedBindings {
  const ranked = entries
    .map((entry, index) => ({ entry, index, depth: entry.seq.split(" ").length }))
    .sort((a, b) => b.entry.layer - a.entry.layer || b.depth - a.depth || b.index - a.index);
  const bindings = new Map<string, string>();
  const prefixes = new Set<string>();
  const accepted = new Set<BindingEntry>();
  for (const { entry } of ranked) {
    const parts = entry.seq.split(" ");
    const starts: string[] = [];
    for (let i = 1; i < parts.length; i++) starts.push(parts.slice(0, i).join(" "));
    if (bindings.has(entry.seq) || prefixes.has(entry.seq) || starts.some((s) => bindings.has(s))) continue;
    bindings.set(entry.seq, entry.id);
    for (const s of starts) prefixes.add(s);
    accepted.add(entry);
  }
  const keys = new Map<string, string[]>();
  for (const entry of entries) {
    if (!accepted.has(entry)) continue;
    const list = keys.get(entry.id);
    if (list) list.push(entry.seq);
    else keys.set(entry.id, [entry.seq]);
  }
  return { bindings, prefixes, keys };
}
