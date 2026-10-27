// CodeMirror configuration. Deliberately lean: no autocompletion, no linting, no
// auto-closing brackets — a text editor, not an IDE.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { classHighlighter, tagHighlighter } from "@lezer/highlight";
import { logTags } from "./languages";

export const language = new Compartment();
export const wrap = new Compartment();
export const indentation = new Compartment();
export const readOnly = new Compartment();
export const gutters = new Compartment();
export const activeLine = new Compartment();

export interface EditorOptions {
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  lineNumbers: boolean;
  highlightActiveLine: boolean;
  readOnly: boolean;
}

const logHighlighter = tagHighlighter([
  { tag: logTags.error, class: "tok-log-error" },
  { tag: logTags.warn, class: "tok-log-warn" },
  { tag: logTags.info, class: "tok-log-info" },
  { tag: logTags.debug, class: "tok-log-debug" },
  { tag: logTags.date, class: "tok-log-date" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "1.5",
  },
  ".cm-content": { caretColor: "var(--caret)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--caret)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--selection) !important" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--line-number)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--active-line-number)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "1px solid var(--search-match-border)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--search-match-selected)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--bracket-match)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--bg-alt)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button": { fontSize: "13px" },
  ".cm-specialChar": { color: "var(--special-char)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-alt)", border: "1px solid var(--border)", color: "var(--fg-dim)" },
});

export function indentationExtension(tabSize: number, insertSpaces: boolean): Extension {
  return [EditorState.tabSize.of(tabSize), indentUnit.of(insertSpaces ? " ".repeat(tabSize) : "\t")];
}

export function gutterExtension(show: boolean): Extension {
  return show ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : [];
}

export function createEditorState(doc: string, options: EditorOptions, extra: Extension): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      gutters.of(gutterExtension(options.lineNumbers)),
      activeLine.of(options.highlightActiveLine ? highlightActiveLine() : []),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(classHighlighter),
      syntaxHighlighting(logHighlighter),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      language.of([]),
      wrap.of(options.wordWrap ? EditorView.lineWrapping : []),
      indentation.of(indentationExtension(options.tabSize, options.insertSpaces)),
      readOnly.of(EditorState.readOnly.of(options.readOnly)),
      theme,
      extra,
    ],
  });
}
