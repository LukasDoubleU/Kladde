// The shortcut editor of the command palette ("Change keyboard shortcut…") and the keymap picker. They
// write keybindings.json and settings.json, keep the entries they do not understand, and apply the result
// at once.

import {
  builtinKeyName,
  currentKeymap,
  defaultKeybindingsJson,
  defaultKeysOf,
  findConflicts,
  KEYBINDINGS_FILE,
  keysOf,
  loadKeybindings,
  registeredActions,
  setKeymap,
} from "./actions";
import { api } from "./api";
import { KEYMAPS, type KeymapName } from "./keymaps";
import { formatSequence, normalizeSequence, sequencesConflict } from "./keys";
import { loadSettings, settings, SETTINGS_FILE } from "./settings.svelte";
import { workspace } from "./workspace.svelte";

// ---------------------------------------------------------------- key capture dialog

export interface CaptureRequest {
  /** What the keys are for, e.g. the command's name. */
  title: string;
  /** The normalized sequence ("ctrl+k ctrl+c"), or null if cancelled. */
  resolve: (sequence: string | null) => void;
}

/** The open capture dialog (KeyCapture.svelte), if any. While it is open, no shortcut runs. */
export const keyCapture: { request: CaptureRequest | null } = $state({ request: null });

function captureKeys(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    keyCapture.request = {
      title,
      resolve: (sequence) => {
        keyCapture.request = null;
        resolve(sequence);
      },
    };
  });
}

// ---------------------------------------------------------------- JSON files

type Json = Record<string, unknown>;

/** Reads a config file as a JSON object; null if it is not valid (it must never be overwritten then). */
async function readObject(name: string): Promise<Json | null> {
  const text = await api.configRead(name);
  if (!text?.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

async function writeConfig(name: string, text: string) {
  const path = await api.configFile(name, "{\n}\n");
  await api.writeFile(path, text, "UTF-8", false, "LF");
}

/** One entry per line, like the files Kladde creates. */
function serializeBindings(entries: Json): string {
  const lines = Object.entries(entries).map(([id, value]) => `  ${JSON.stringify(id)}: ${JSON.stringify(value)}`);
  return lines.length ? `{\n${lines.join(",\n")}\n}\n` : defaultKeybindingsJson();
}

const sameKeys = (a: string[], b: string[]) => a.map(normalizeSequence).join("|") === b.map(normalizeSequence).join("|");

/** Sets the keys of an action in the file's entries; an entry that only repeats the default is dropped. */
function setEntry(entries: Json, id: string, keys: string[]) {
  const formatted = keys.map(formatSequence);
  if (sameKeys(formatted, defaultKeysOf(id))) delete entries[id];
  else entries[id] = formatted.length === 0 ? null : formatted.length === 1 ? formatted[0] : formatted;
}

async function saveBindings(entries: Json): Promise<boolean> {
  try {
    await writeConfig(KEYBINDINGS_FILE, serializeBindings(entries));
  } catch (e) {
    workspace.showNotice("error", `Could not write ${KEYBINDINGS_FILE}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  const error = await loadKeybindings();
  if (error) workspace.showNotice("error", error);
  return !error;
}

// ---------------------------------------------------------------- change a shortcut

const keysText = (id: string) => keysOf(id).map(formatSequence).join(" / ");

/** Palette command: pick a command, then set, add or remove its shortcut, or reset it. */
export async function changeKeybinding() {
  const items = registeredActions()
    .map((a) => ({ id: a.id, label: a.label, detail: `${keysText(a.id)}${keysOf(a.id).length ? " · " : ""}${a.id}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const picked = await workspace.pick({ placeholder: "Change the keyboard shortcut of…", items });
  if (!picked || typeof picked === "string") return;
  const id = picked.id;
  const label = picked.label;

  const entries = await readObject(KEYBINDINGS_FILE);
  if (!entries) {
    workspace.showNotice("error", `${KEYBINDINGS_FILE} is not valid JSON. Fix it first (Open keyboard shortcuts), then try again.`);
    return;
  }
  const has = keysOf(id).length > 0;
  const choices = [
    { id: "set", label: "Set shortcut…", detail: has ? `now ${keysText(id)}` : "none yet" },
    ...(has ? [{ id: "add", label: "Add another shortcut…", detail: `keeps ${keysText(id)}` }] : []),
    ...(has ? [{ id: "remove", label: "Remove shortcut", detail: keysText(id) }] : []),
    ...(id in entries
      ? [{ id: "reset", label: "Reset to default", detail: defaultKeysOf(id).map(formatSequence).join(" / ") || "no shortcut" }]
      : []),
  ];
  const choice = await workspace.pick({ placeholder: label, items: choices });
  if (!choice || typeof choice === "string") return;

  if (choice.id === "remove") {
    setEntry(entries, id, []);
    if (await saveBindings(entries)) workspace.showNotice("info", `Removed the shortcut of “${label}”.`);
  } else if (choice.id === "reset") {
    delete entries[id];
    if (await saveBindings(entries)) {
      workspace.showNotice("info", `“${label}” has its default shortcut again${keysText(id) ? `: ${keysText(id)}` : ""}.`);
    }
  } else {
    const sequence = await captureKeys(label);
    if (sequence) await assignKey(entries, id, label, sequence, choice.id === "add");
  }
}

/** Gives an action a key, after warning about what else uses it. */
async function assignKey(entries: Json, id: string, label: string, sequence: string, add: boolean) {
  const shown = formatSequence(sequence);
  const conflicts = findConflicts(sequence, id);
  if (conflicts.length) {
    const text = conflicts
      .map((c) => {
        const key = formatSequence(c.key);
        if (c.key === sequence) return `is already used by “${c.label}”`;
        if (c.key.startsWith(sequence + " ")) return `is the first key of ${key} (“${c.label}”)`;
        return `cannot start a chord, because ${key} already runs “${c.label}”`;
      })
      .join(", and ");
    const choice = await workspace.ask(
      `${shown} ${text}.`,
      [
        { id: "replace", label: "Replace", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      "Replacing removes that shortcut from the other command.",
    );
    if (choice !== "replace") return;
  } else {
    const builtin = builtinKeyName(sequence);
    if (builtin) {
      const choice = await workspace.ask(
        `${shown} is used by the editor for “${builtin}”.`,
        [
          { id: "use", label: "Use anyway", primary: true },
          { id: "cancel", label: "Cancel" },
        ],
        "The editor function stops working on this key.",
      );
      if (choice !== "use") return;
    }
  }

  // The other commands keep their remaining keys; writing them out keeps the change independent of the presets.
  for (const other of new Set(conflicts.map((c) => c.id))) {
    setEntry(entries, other, keysOf(other).filter((k) => !sequencesConflict(k, sequence)));
  }
  const keys = add ? [...keysOf(id).filter((k) => k !== sequence), sequence] : [sequence];
  setEntry(entries, id, keys);
  if (await saveBindings(entries)) workspace.showNotice("info", `${shown} now runs “${label}”.`);
}

// ---------------------------------------------------------------- keymap preset

/** Palette command: choose the base keymap (setting `keymap`). */
export async function chooseKeymap() {
  const current = currentKeymap();
  const items = (Object.keys(KEYMAPS) as KeymapName[]).map((name) => ({
    id: name,
    label: KEYMAPS[name].label + (name === current ? " (current)" : ""),
    detail: KEYMAPS[name].description,
  }));
  const picked = await workspace.pick({ placeholder: "Select the keyboard shortcut preset", items });
  if (!picked || typeof picked === "string") return;

  const file = await readObject(SETTINGS_FILE);
  if (!file) {
    workspace.showNotice("error", `${SETTINGS_FILE} is not valid JSON. Fix it first (Open settings), then try again.`);
    return;
  }
  file.keymap = picked.id;
  try {
    const path = await api.configFile(SETTINGS_FILE, "{\n}\n");
    await api.writeFile(path, JSON.stringify(file, null, 2) + "\n", "UTF-8", false, "LF");
  } catch (e) {
    workspace.showNotice("error", `Could not write ${SETTINGS_FILE}: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const error = await loadSettings();
  setKeymap(settings.keymap);
  workspace.showNotice(error ? "error" : "info", error ?? `Keyboard shortcuts: ${KEYMAPS[picked.id as KeymapName].label} preset.`);
}
