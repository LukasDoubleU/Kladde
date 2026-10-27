// The diff views of compare tabs. Loaded lazily (dynamic import from Compare.svelte), so
// @codemirror/merge stays out of the startup bundle.

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  Change,
  type DiffConfig,
  diff,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  MergeView,
  unifiedMergeView,
} from "@codemirror/merge";

export interface CompareOptions {
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
  /** One column with deleted lines above the inserted ones, instead of two columns. */
  unified: boolean;
}

export interface CompareHandle {
  /** Number of changed blocks. */
  changes: number;
  next(): void;
  previous(): void;
  /** Moves the cursor to the first change and scrolls to it. */
  showFirst(): void;
  scrollTop: number;
  destroy(): void;
}

const BASE_DIFF: DiffConfig = { scanLimit: 500, timeout: 2000 };

/**
 * `a` without what the options ignore, and for every kept character its index in `a`.
 * Line breaks always stay, so lines that merely differ in indentation still pair up.
 */
function normalize(a: string, options: CompareOptions) {
  let text = "";
  const index: number[] = [];
  for (let i = 0; i < a.length; i++) {
    let ch = a[i];
    if (options.ignoreWhitespace && (ch === " " || ch === "\t" || ch === " ")) continue;
    if (options.ignoreCase) {
      const lower = ch.toLowerCase();
      // Characters whose lower case has another length would shift the indices.
      if (lower.length === 1) ch = lower;
    }
    text += ch;
    index.push(i);
  }
  return { text, index };
}

/** Diffs the normalized texts and maps the changes back onto the original ones. */
export function diffIgnoring(a: string, b: string, options: CompareOptions): readonly Change[] {
  const na = normalize(a, options);
  const nb = normalize(b, options);
  type Normalized = ReturnType<typeof normalize>;
  // The position before kept character `p`; changes at the very end map to the end of the original.
  const before = (n: Normalized, text: string, p: number) => (p < n.index.length ? n.index[p] : text.length);
  // The position after the last kept character of a non-empty range; an empty range stays a point.
  const after = (n: Normalized, from: number, to: number, point: number) => (to > from ? n.index[to - 1] + 1 : point);
  return diff(na.text, nb.text, BASE_DIFF).map((c) => {
    const fromA = before(na, a, c.fromA);
    const fromB = before(nb, b, c.fromB);
    return new Change(fromA, after(na, c.fromA, c.toA, fromA), fromB, after(nb, c.fromB, c.toB, fromB));
  });
}

function diffConfig(options: CompareOptions): DiffConfig {
  if (!options.ignoreWhitespace && !options.ignoreCase) return BASE_DIFF;
  return { ...BASE_DIFF, override: (a, b) => diffIgnoring(a, b, options) };
}

/** Builds the diff view of `left` and `right` in `parent`. `extensions` set the look of both editors. */
export function createCompare(
  parent: HTMLElement,
  left: string,
  right: string,
  extensions: Extension,
  options: CompareOptions,
): CompareHandle {
  const config = diffConfig(options);

  if (options.unified) {
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: right,
        extensions: [extensions, unifiedMergeView({ original: left, diffConfig: config, mergeControls: false })],
      }),
    });
    const run = (command: typeof goToNextChunk) => {
      command(view);
      view.focus();
    };
    return {
      changes: getChunks(view.state)?.chunks.length ?? 0,
      next: () => run(goToNextChunk),
      previous: () => run(goToPreviousChunk),
      showFirst: () => showFirst(view, getChunks(view.state)?.chunks[0]?.fromB),
      get scrollTop() {
        return view.scrollDOM.scrollTop;
      },
      set scrollTop(value: number) {
        view.scrollDOM.scrollTop = value;
      },
      destroy: () => view.destroy(),
    };
  }

  const merge = new MergeView({ parent, a: { doc: left, extensions }, b: { doc: right, extensions }, diffConfig: config });
  // Continue from where the cursor is: in the side that has the focus, else in the right one.
  const current = () => (merge.a.hasFocus ? merge.a : merge.b);
  const run = (command: typeof goToNextChunk) => {
    const view = current();
    command(view);
    view.focus();
  };
  return {
    changes: merge.chunks.length,
    next: () => run(goToNextChunk),
    previous: () => run(goToPreviousChunk),
    showFirst: () => showFirst(merge.b, merge.chunks[0]?.fromB),
    // The merge view's own element scrolls both editors.
    get scrollTop() {
      return merge.dom.scrollTop;
    },
    set scrollTop(value: number) {
      merge.dom.scrollTop = value;
    },
    destroy: () => merge.destroy(),
  };
}

function showFirst(view: EditorView, pos: number | undefined) {
  if (pos === undefined) return;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 40 }) });
}
