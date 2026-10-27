// CodeMirror's editing commands as actions, so they show up in the command palette with their keys
// and can be rebound or unbound in keybindings.json like every other command.
//
// The keys of these commands live here and nowhere else: editor.ts drops the stock bindings of the
// commands below from CodeMirror's keymaps, so unbinding an action really frees its key.

import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  deleteLine,
  deleteTrailingWhitespace,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  lineComment,
  lineUncomment,
  moveLineDown,
  moveLineUp,
  selectLine,
  selectParentSyntax,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { findNext, findPrevious, openSearchPanel, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import type { Action } from "./actions";
import { writeText } from "./clipboard.ts";

/** Upper or lower case of the selection, or of the word at each cursor. */
function changeCase(upper: boolean): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const tr = state.changeByRange((range) => {
      const target = range.empty ? state.wordAt(range.head) : range;
      if (!target) return { range };
      const text = state.sliceDoc(target.from, target.to);
      const next = upper ? text.toUpperCase() : text.toLowerCase();
      if (next === text) return { range };
      const changes = { from: target.from, to: target.to, insert: next };
      if (range.empty) return { changes, range: EditorSelection.cursor(target.from + Math.min(range.head - target.from, next.length)) };
      const end = target.from + next.length;
      return { changes, range: range.anchor <= range.head ? EditorSelection.range(target.from, end) : EditorSelection.range(end, target.from) };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: "input.case" });
    return true;
  };
}

/** Joins each selected line with the next one (the line with the cursor if nothing spans lines). */
const joinLines: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const breaks = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A selection that ends at the start of a line does not include that line.
    if (last > first && range.to === state.doc.line(last).from) last--;
    for (let n = first; n <= Math.max(first, last - 1) && n < state.doc.lines; n++) breaks.add(n);
  }
  const changes = [...breaks].map((n) => {
    const line = state.doc.line(n);
    const next = state.doc.line(n + 1);
    const indent = /^\s*/.exec(next.text)![0].length;
    const bare = indent === next.length || line.length === 0 || /\s$/.test(line.text);
    return { from: line.to, to: next.from + indent, insert: bare ? "" : " " };
  });
  if (!changes.length) return false;
  view.dispatch({ changes, scrollIntoView: true, userEvent: "delete.join" });
  return true;
};

/** Sorts the selected lines, or all lines if nothing is selected. */
function sortLines(descending: boolean): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const { main } = state.selection;
    let from = 0;
    let to = state.doc.length;
    if (!main.empty) {
      from = state.doc.lineAt(main.from).from;
      const endLine = state.doc.lineAt(main.to);
      to = main.to === endLine.from && main.to > main.from ? state.doc.lineAt(main.to - 1).to : endLine.to;
    }
    const lines = state.sliceDoc(from, to).split("\n");
    // The final line break stays at the end instead of sorting an empty line to the top.
    const trailing = lines.length > 1 && lines[lines.length - 1] === "";
    if (trailing) lines.pop();
    // Code point order, like Notepad++'s "lexicographically": the same result on every machine.
    lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (descending) lines.reverse();
    if (trailing) lines.push("");
    const text = lines.join("\n");
    if (text === state.sliceDoc(from, to)) return true;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: main.empty ? undefined : EditorSelection.range(from, from + text.length),
      scrollIntoView: true,
      userEvent: "input.sort",
    });
    return true;
  };
}

/** Moves the lines of the selection to the clipboard (Notepad++'s "Cut Current Line"). */
const cutLine: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    // Like deleteLine: a selection that ends at the start of a line does not include that line.
    const end = state.doc.lineAt(range.to);
    const last = !range.empty && range.to === end.from ? end.number - 1 : end.number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) numbers.add(n);
  }
  const text = [...numbers].map((n) => state.doc.line(n).text).join("\n") + "\n";
  void writeText(text).catch(() => {});
  return deleteLine(view);
};

interface EditorCommand {
  id: string;
  label: string;
  /** Default keys; none means the command is only in the command palette. */
  keys?: string[];
  command: Command;
}

export const editorCommands: EditorCommand[] = [
  { id: "edit.deleteLine", label: "Delete line", keys: ["Ctrl+D", "Ctrl+Shift+K"], command: deleteLine },
  { id: "editor.cutLine", label: "Cut line", command: cutLine },
  { id: "editor.duplicateLine", label: "Duplicate line (below)", keys: ["Shift+Alt+Down"], command: copyLineDown },
  { id: "editor.copyLineUp", label: "Duplicate line (above)", keys: ["Shift+Alt+Up"], command: copyLineUp },
  { id: "editor.moveLineUp", label: "Move line up", keys: ["Alt+Up"], command: moveLineUp },
  { id: "editor.moveLineDown", label: "Move line down", keys: ["Alt+Down"], command: moveLineDown },
  { id: "editor.joinLines", label: "Join lines", keys: ["Ctrl+J"], command: joinLines },
  { id: "editor.sortLinesAscending", label: "Sort lines ascending", command: sortLines(false) },
  { id: "editor.sortLinesDescending", label: "Sort lines descending", command: sortLines(true) },
  { id: "editor.insertBlankLine", label: "Insert blank line below", keys: ["Ctrl+Enter"], command: insertBlankLine },
  { id: "editor.trimTrailingWhitespace", label: "Trim trailing whitespace", command: deleteTrailingWhitespace },
  { id: "editor.toUpperCase", label: "Transform to upper case", command: changeCase(true) },
  { id: "editor.toLowerCase", label: "Transform to lower case", command: changeCase(false) },
  { id: "editor.toggleComment", label: "Toggle line comment", keys: ["Ctrl+/"], command: toggleComment },
  { id: "editor.lineComment", label: "Add line comment", command: lineComment },
  { id: "editor.lineUncomment", label: "Remove line comment", command: lineUncomment },
  { id: "editor.toggleBlockComment", label: "Toggle block comment", keys: ["Shift+Alt+A"], command: toggleBlockComment },
  { id: "editor.indentMore", label: "Indent", keys: ["Ctrl+]"], command: indentMore },
  { id: "editor.indentLess", label: "Outdent", keys: ["Ctrl+["], command: indentLess },
  { id: "editor.indentSelection", label: "Auto-indent selection", keys: ["Ctrl+Alt+\\"], command: indentSelection },
  { id: "editor.selectLine", label: "Select line", keys: ["Alt+L"], command: selectLine },
  { id: "editor.selectParentSyntax", label: "Expand selection to the enclosing syntax", keys: ["Ctrl+I"], command: selectParentSyntax },
  { id: "editor.selectNextOccurrence", label: "Select next occurrence", keys: ["Ctrl+Shift+D"], command: selectNextOccurrence },
  { id: "editor.selectAllOccurrences", label: "Select all occurrences of the selection", keys: ["Ctrl+Shift+L"], command: selectSelectionMatches },
  { id: "editor.addCursorAbove", label: "Add cursor above", keys: ["Ctrl+Alt+Up"], command: addCursorAbove },
  { id: "editor.addCursorBelow", label: "Add cursor below", keys: ["Ctrl+Alt+Down"], command: addCursorBelow },
  { id: "editor.cursorMatchingBracket", label: "Go to matching bracket", keys: ["Ctrl+Shift+\\"], command: cursorMatchingBracket },
  { id: "editor.foldCode", label: "Fold", keys: ["Ctrl+Shift+["], command: foldCode },
  { id: "editor.unfoldCode", label: "Unfold", keys: ["Ctrl+Shift+]"], command: unfoldCode },
  { id: "editor.foldAll", label: "Fold all", keys: ["Ctrl+Alt+["], command: foldAll },
  { id: "editor.unfoldAll", label: "Unfold all", keys: ["Ctrl+Alt+]"], command: unfoldAll },
  { id: "editor.find", label: "Find", keys: ["Ctrl+F"], command: openSearchPanel },
  { id: "editor.findNext", label: "Find next", keys: ["F3"], command: findNext },
  { id: "editor.findPrevious", label: "Find previous", keys: ["Shift+F3"], command: findPrevious },
];

/** The commands above, to be dropped from CodeMirror's stock keymaps. */
export const exposedCommands: ReadonlySet<Command> = new Set(editorCommands.map((c) => c.command));

/** The actions for the registry. `enabled` tells whether the active tab is an editor. */
export function editorActions(getView: () => EditorView | null, enabled: () => boolean): Action[] {
  return editorCommands.map(({ id, label, keys, command }) => ({
    id,
    label,
    keys,
    run: () => {
      const view = getView();
      if (view) command(view);
    },
    enabled,
  }));
}
