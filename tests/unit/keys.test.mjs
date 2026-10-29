// Unit tests for key parsing, chords, conflict resolution and the keymap presets:
//   npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const src = resolve(import.meta.dirname, "../../src");
const load = (name) => import(pathToFileURL(resolve(src, "lib", name)).href);
const keys = await load("keys.ts");
const { KEYMAPS, keymapNamed } = await load("keymaps.ts");
const { editorCommands } = await load("editor-actions.ts");

const event = (init) => ({ key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init });

test("normalizes combos and sequences", () => {
  assert.equal(keys.normalizeCombo("Shift+Ctrl+S"), "ctrl+shift+s");
  assert.equal(keys.normalizeCombo("Ctrl+Plus"), "ctrl+plus");
  assert.equal(keys.normalizeCombo("Ctrl++"), "ctrl+plus");
  assert.equal(keys.normalizeCombo("alt+left"), "alt+arrowleft");
  assert.equal(keys.normalizeCombo("Control+Esc"), "ctrl+escape");
  assert.equal(keys.normalizeCombo("Ctrl+"), "");
  assert.equal(keys.normalizeSequence("Ctrl+K  Ctrl+C"), "ctrl+k ctrl+c");
  assert.equal(keys.normalizeSequence("Ctrl + K V"), "ctrl+k v");
  assert.equal(keys.normalizeSequence("Ctrl+K Ctrl+"), "");
  assert.equal(keys.normalizeSequence(""), "");
});

test("formats keys for display", () => {
  assert.equal(keys.formatSequence("ctrl+shift+arrowup"), "Ctrl+Shift+Up");
  assert.equal(keys.formatSequence("Ctrl+K Ctrl+C"), "Ctrl+K Ctrl+C");
  assert.equal(keys.formatSequence("ctrl+k v"), "Ctrl+K V");
  assert.equal(keys.formatSequence("f5"), "F5");
  assert.equal(keys.formatSequence("ctrl+plus"), "Ctrl++");
});

test("reads key events", () => {
  const c = (init) => keys.comboFromEvent(event(init));
  assert.equal(c({ key: "s", code: "KeyS", ctrlKey: true }), "ctrl+s");
  assert.equal(c({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }), "ctrl+shift+s");
  assert.equal(c({ key: "ArrowUp", code: "ArrowUp", altKey: true }), "alt+arrowup");
  assert.equal(c({ key: "F5", code: "F5" }), "f5");
  assert.equal(c({ key: " ", code: "Space", ctrlKey: true }), "ctrl+space");
  assert.equal(c({ key: "!", code: "Digit1", shiftKey: true, ctrlKey: true }), "ctrl+shift+1");
  // Shifted punctuation is matched by the key, not by the character it types.
  assert.equal(c({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }), "ctrl+shift+[");
  assert.equal(c({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true }), "ctrl+shift+\\");
  assert.equal(c({ key: "Ü", code: "BracketLeft", ctrlKey: true, shiftKey: true }), "ctrl+shift+ü");
  assert.equal(c({ key: "Control", code: "ControlLeft", ctrlKey: true }), null);
  // AltGr (Ctrl+Alt on Windows) types characters such as [ and @.
  assert.equal(c({ key: "[", code: "Digit8", ctrlKey: true, altKey: true, getModifierState: (m) => m === "AltGraph" }), null);
});

test("only keys that are not for typing can start a binding", () => {
  assert.ok(keys.isShortcutStart("ctrl+k"));
  assert.ok(keys.isShortcutStart("alt+shift+arrowup"));
  assert.ok(keys.isShortcutStart("f5"));
  assert.ok(keys.isShortcutStart("shift+f7"));
  assert.ok(!keys.isShortcutStart("k"));
  assert.ok(!keys.isShortcutStart("shift+k"));
  assert.ok(!keys.isShortcutStart("enter"));
  assert.ok(!keys.isShortcutStart("shift+arrowleft"));
});

test("conflicts: equal keys and chords that start with a key", () => {
  assert.ok(keys.sequencesConflict("ctrl+k", "ctrl+k"));
  assert.ok(keys.sequencesConflict("ctrl+k", "ctrl+k ctrl+c"));
  assert.ok(keys.sequencesConflict("ctrl+k ctrl+c", "ctrl+k"));
  assert.ok(!keys.sequencesConflict("ctrl+k ctrl+c", "ctrl+k ctrl+u"));
  assert.ok(!keys.sequencesConflict("ctrl+k", "ctrl+kk"));
});

test("resolving: a higher layer takes the key, a chord beats its first key", () => {
  const r = keys.resolveBindings([
    { id: "a", seq: "ctrl+d", layer: 0 },
    { id: "a", seq: "ctrl+shift+k", layer: 0 },
    { id: "b", seq: "ctrl+d", layer: 1 },
    { id: "c", seq: "ctrl+k", layer: 0 },
    { id: "d", seq: "ctrl+k ctrl+c", layer: 0 },
    { id: "e", seq: "alt+x", layer: 0 },
    { id: "f", seq: "alt+x", layer: 2 },
  ]);
  assert.equal(r.bindings.get("ctrl+d"), "b");
  assert.deepEqual(r.keys.get("a"), ["ctrl+shift+k"]);
  assert.equal(r.bindings.has("ctrl+k"), false);
  assert.equal(r.bindings.get("ctrl+k ctrl+c"), "d");
  assert.ok(r.prefixes.has("ctrl+k"));
  assert.equal(r.keys.has("c"), false);
  assert.equal(r.bindings.get("alt+x"), "f");
  assert.equal(r.keys.has("e"), false);
});

test("resolving: a user's key frees the default chord that starts with it", () => {
  const r = keys.resolveBindings([
    { id: "chord", seq: "ctrl+k ctrl+c", layer: 1 },
    { id: "mine", seq: "ctrl+k", layer: 2 },
  ]);
  assert.equal(r.bindings.get("ctrl+k"), "mine");
  assert.equal(r.prefixes.size, 0);
  assert.equal(r.keys.has("chord"), false);
});

// ---------------------------------------------------------------- the real tables

/** Command ids and default keys of App.svelte's action list. */
function appActions() {
  const source = readFileSync(resolve(src, "App.svelte"), "utf8");
  const list = [];
  for (const chunk of source.split(/\bid: "/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    if (!/^[a-z]+\.[A-Za-z]+$/.test(id)) continue;
    const found = /keys: \[([^\]]*)\]/.exec(chunk.split(/\n {4}\},?\n|\n {4}\{ id/)[0]);
    list.push({ id, keys: found ? [...found[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [] });
  }
  return list;
}

const all = [...appActions(), ...editorCommands.map((c) => ({ id: c.id, keys: c.keys ?? [] }))];

test("command ids are unique and found", () => {
  const ids = all.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["file.save", "file.reload", "tab.back", "edit.deleteLine", "editor.duplicateLine", "keybindings.change"]) {
    assert.ok(ids.includes(id), id);
  }
});

const entriesOf = (list, layer) =>
  list.flatMap((a) => a.keys.map((key) => ({ id: a.id, seq: keys.normalizeSequence(key), layer })));

test("default keys are valid and do not clash", () => {
  const entries = entriesOf(all, 0);
  for (const e of entries) assert.ok(e.seq, `invalid key of ${e.id}`);
  const r = keys.resolveBindings(entries);
  assert.equal(r.bindings.size, entries.length, "a default key was dropped");
});

test("owner defaults stay", () => {
  const r = keys.resolveBindings(entriesOf(all, 0));
  const at = (k) => r.bindings.get(keys.normalizeSequence(k));
  assert.equal(at("Ctrl+D"), "edit.deleteLine");
  assert.equal(at("Alt+Shift+W"), "file.reveal");
  assert.equal(at("Ctrl+T"), "file.new");
  assert.equal(at("Ctrl+N"), "file.new");
  assert.equal(at("F5"), "file.reload");
  assert.equal(at("Alt+Left"), "tab.back");
  assert.equal(at("Alt+Right"), "tab.forward");
  assert.equal(at("Ctrl+W"), "file.close");
  assert.equal(at("Ctrl+Shift+T"), "file.reopenClosed");
  // The settings page has IntelliJ's key; "save all" moved next to it.
  assert.equal(at("Ctrl+Alt+S"), "settings.show");
  assert.equal(at("Ctrl+Alt+Shift+S"), "file.saveAll");
  assert.equal(at("Ctrl+S"), "file.save");
  assert.equal(at("Ctrl+Shift+S"), "file.saveAs");
  // The key CodeMirror's "select next occurrence" lost to Ctrl+D.
  assert.equal(at("Ctrl+Shift+D"), "editor.selectNextOccurrence");
});

/** The bindings under a preset, built like actions.ts does it. */
function presetBindings(name) {
  const keymap = KEYMAPS[name];
  const entries = all.flatMap((a) => {
    const layer = a.id in keymap.keys ? 1 : 0;
    return (layer ? keymap.keys[a.id] : a.keys).map((k) => ({ id: a.id, seq: keys.normalizeSequence(k), layer }));
  });
  for (const e of entries) assert.ok(e.seq, `${name}: invalid key of ${e.id}`);
  return { entries, resolved: keys.resolveBindings(entries) };
}

test("presets only name known commands and keep all their keys", () => {
  const ids = new Set(all.map((a) => a.id));
  for (const name of Object.keys(KEYMAPS)) {
    for (const id of Object.keys(KEYMAPS[name].keys)) assert.ok(ids.has(id), `${name}: unknown command ${id}`);
    const { entries, resolved } = presetBindings(name);
    const lost = entries.filter((e) => e.layer === 1 && resolved.bindings.get(e.seq) !== e.id);
    assert.deepEqual(lost, [], `${name}: a preset key was dropped`);
  }
});

test("a preset only takes default keys away through keys it names itself", () => {
  for (const name of Object.keys(KEYMAPS)) {
    const { entries, resolved } = presetBindings(name);
    const presetIds = new Set(entries.filter((e) => e.layer === 1).map((e) => e.id));
    for (const e of entries.filter((e) => e.layer === 0)) {
      if (resolved.bindings.get(e.seq) === e.id) continue;
      const owner = resolved.bindings.get(e.seq);
      assert.ok(
        (owner && presetIds.has(owner)) || resolved.prefixes.has(e.seq),
        `${name}: ${e.id} lost ${e.seq} to ${owner ?? "a chord"}, which the preset does not name`,
      );
    }
    // No key is bound twice and none is both a command and the start of a chord.
    for (const seq of resolved.bindings.keys()) assert.equal(resolved.prefixes.has(seq), false, `${name}: ${seq}`);
  }
});

test("presets give the documented keys", () => {
  const npp = presetBindings("notepad++").resolved.bindings;
  assert.equal(npp.get("ctrl+d"), "editor.duplicateLine");
  assert.equal(npp.get("ctrl+shift+l"), "edit.deleteLine");
  assert.equal(npp.get("ctrl+shift+arrowup"), "editor.moveLineUp");
  assert.equal(npp.has("alt+arrowup"), false);
  assert.equal(npp.get("ctrl+alt+s"), "file.saveAs");
  assert.equal(npp.get("ctrl+shift+s"), "file.saveAll");
  assert.equal(npp.get("ctrl+alt+shift+s"), undefined);
  assert.equal([...npp.values()].includes("settings.show"), false, "Ctrl+Alt+S is save as in Notepad++");
  assert.equal(npp.get("ctrl+t"), "file.new");
  assert.equal(npp.get("f5"), "file.reload");
  const code = presetBindings("vscode").resolved.bindings;
  assert.equal(code.get("ctrl+d"), "editor.selectNextOccurrence");
  assert.equal(code.get("ctrl+shift+k"), "edit.deleteLine");
  assert.equal(code.get("ctrl+k ctrl+c"), "editor.lineComment");
  assert.equal(code.has("ctrl+k"), false);
  assert.equal(code.get("alt+arrowup"), "editor.moveLineUp");
  assert.equal(code.get("ctrl+,"), "settings.show");
  // The key event of Ctrl+, resolves to the same sequence.
  assert.equal(keys.comboFromEvent(event({ key: ",", code: "Comma", ctrlKey: true })), "ctrl+,");
  assert.equal(code.get("ctrl+alt+s"), "settings.show");
});

test("keymap names are forgiving", () => {
  assert.equal(keymapNamed("Notepad++"), "notepad++");
  assert.equal(keymapNamed("VS Code"), "vscode");
  assert.equal(keymapNamed("vs-code"), "vscode");
  assert.equal(keymapNamed("default"), "default");
  assert.equal(keymapNamed("emacs"), null);
  assert.equal(keymapNamed(3), null);
});

// ---------------------------------------------------------------- the commands implemented here

const { EditorState, EditorSelection } = await import("@codemirror/state");

/** Runs a command on a document with a selection ("[" and "]" are removed and mark the selection). */
function run(id, marked) {
  const from = marked.indexOf("[");
  const doc = marked.replace(/[[\]]/g, "");
  const to = marked.indexOf("]") - (from >= 0 ? 1 : 0);
  const view = {
    state: EditorState.create({ doc, selection: from >= 0 ? EditorSelection.range(from, to) : undefined }),
    dispatch(...specs) {
      this.state = this.state.update(...specs).state;
    },
  };
  const command = editorCommands.find((c) => c.id === id).command;
  command(view);
  const sel = view.state.selection.main;
  const text = view.state.doc.toString();
  return sel.empty ? text : `${text.slice(0, sel.from)}[${text.slice(sel.from, sel.to)}]${text.slice(sel.to)}`;
}

test("join lines: selection, cursor line, indentation and blank lines", () => {
  assert.equal(run("editor.joinLines", "a[\n  b\n  c]\nd"), "a[ b c]\nd");
  // Without a selection the line with the cursor (at the start) joins the next one.
  assert.equal(run("editor.joinLines", "a\nb\nc"), "a b\nc");
  assert.equal(run("editor.joinLines", "x[a]\n   b\nc"), "x[a] b\nc");
  assert.equal(run("editor.joinLines", "a \n\n b[]"), "a \n\n b");
  assert.equal(run("editor.joinLines", "[a\nb\n]c"), "[a b\n]c");
});

test("sort lines: the selection, or the whole document without one", () => {
  assert.equal(run("editor.sortLinesAscending", "c\nb\na\n"), "a\nb\nc\n");
  assert.equal(run("editor.sortLinesDescending", "a\nc\nb"), "c\nb\na");
  assert.equal(run("editor.sortLinesAscending", "z\n[c\nb]\na"), "z\n[b\nc]\na");
});

test("upper and lower case: the selection, or the word at the cursor", () => {
  assert.equal(run("editor.toUpperCase", "a [bc] d"), "a [BC] d");
  assert.equal(run("editor.toUpperCase", "a bc d"), "A bc d");
  assert.equal(run("editor.toLowerCase", "A [BC] D"), "A [bc] D");
});
