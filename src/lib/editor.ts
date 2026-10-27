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
  type KeyBinding,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { classHighlighter, tagHighlighter } from "@lezer/highlight";
import { exposedCommands } from "./editor-actions";
import { logTags } from "./languages";

export const language = new Compartment();
export const wrap = new Compartment();
export const indentation = new Compartment();
export const readOnly = new Compartment();
export const gutters = new Compartment();
export const activeLine = new Compartment();
export const spelling = new Compartment();

export interface EditorOptions {
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  lineNumbers: boolean;
  highlightActiveLine: boolean;
  readOnly: boolean;
  spellCheck: boolean;
}

export const logHighlighter = tagHighlighter([
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
    fontVariantLigatures: "var(--editor-ligatures)",
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
  // Search and replace panel (Ctrl+F / Ctrl+H)
  ".cm-panel.cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "6px 34px 6px 8px",
    fontFamily: "var(--ui-font)",
    fontSize: "12px",
  },
  ".cm-panel.cm-search br": { flexBasis: "100%", height: 0 },
  ".cm-panel.cm-search .cm-textfield": {
    width: "260px",
    margin: 0,
    padding: "4px 8px",
    font: "inherit",
    fontSize: "13px",
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    outline: "none",
  },
  ".cm-panel.cm-search .cm-textfield:focus": { borderColor: "var(--accent)" },
  ".cm-panel.cm-search .cm-button": {
    margin: 0,
    padding: "4px 10px",
    font: "inherit",
    color: "var(--fg)",
    backgroundColor: "var(--bg-hover)",
    backgroundImage: "none",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  },
  ".cm-panel.cm-search .cm-button:hover": { borderColor: "var(--accent)" },
  ".cm-panel.cm-search .cm-button:active": { backgroundColor: "var(--accent)", color: "var(--accent-fg)" },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    margin: "0 2px",
    color: "var(--fg-dim)",
    fontSize: "12px",
  },
  ".cm-panel.cm-search input[type=checkbox]": { margin: 0, accentColor: "var(--accent)" },
  ".cm-panel.cm-search [name=close]": {
    top: "8px",
    right: "10px",
    fontSize: "18px",
    lineHeight: 1,
    color: "var(--fg-dim)",
    cursor: "pointer",
  },
  ".cm-panel.cm-search [name=close]:hover": { color: "var(--fg)" },
  ".cm-specialChar": { color: "var(--special-char)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-alt)", border: "1px solid var(--border)", color: "var(--fg-dim)" },
});

/** Labels of CodeMirror's search panel, capitalized like the rest of the UI. */
const phrases = EditorState.phrases.of({
  Find: "Find",
  Replace: "Replace",
  next: "Next",
  previous: "Previous",
  all: "All",
  "match case": "Match case",
  regexp: "Regex",
  "by word": "Whole word",
  replace: "Replace",
  "replace all": "Replace all",
  close: "Close",
});

/**
 * CodeMirror's stock keymaps without the commands that are actions (editor-actions.ts): those get
 * their keys from the action table, where they can be rebound, and must not keep a second owner here.
 * Cursor movement, deleting, Enter, undo and so on stay with CodeMirror.
 */
const stockKeymap: readonly KeyBinding[] = [...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap].filter(
  (b) => !(b.run && exposedCommands.has(b.run)) && !(b.shift && exposedCommands.has(b.shift)),
);

export function indentationExtension(tabSize: number, insertSpaces: boolean): Extension {
  return [EditorState.tabSize.of(tabSize), indentUnit.of(insertSpaces ? " ".repeat(tabSize) : "\t")];
}

/** WebView2's spellchecker, which uses the Windows dictionaries. */
export function spellCheckExtension(on: boolean): Extension {
  return EditorView.contentAttributes.of({ spellcheck: on ? "true" : "false" });
}

export function gutterExtension(show: boolean): Extension {
  return show ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : [];
}

/** Look and basic behavior of the compare editors: the same theme and highlighting, but read-only. */
export function readOnlyViewExtensions(options: { wordWrap: boolean; tabSize: number }, lang: Extension): Extension {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    syntaxHighlighting(classHighlighter),
    syntaxHighlighting(logHighlighter),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    EditorState.readOnly.of(true),
    EditorState.tabSize.of(options.tabSize),
    options.wordWrap ? EditorView.lineWrapping : [],
    spellCheckExtension(false),
    lang,
    theme,
  ];
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
      keymap.of([...stockKeymap, indentWithTab]),
      language.of([]),
      wrap.of(options.wordWrap ? EditorView.lineWrapping : []),
      indentation.of(indentationExtension(options.tabSize, options.insertSpaces)),
      readOnly.of(EditorState.readOnly.of(options.readOnly)),
      spelling.of(spellCheckExtension(options.spellCheck)),
      theme,
      phrases,
      extra,
    ],
  });
}
