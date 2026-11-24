// Live Preview: formulas and diagrams. Inline math is a widget made by the plugin in live-preview.ts; display math,
// ```math fences and ```mermaid fences replace whole lines, which only a state field may do, so this file holds that
// field (`blockExtension`), the widgets, and the effect with which the plugin tells the field that a mouse button is
// held. Which ranges are such blocks is decided by the pure live-preview-math.ts.
//
// Rendering is the preview's: KaTeX through `texToHtml` (lazy, cached, the same options and errors), Mermaid through
// `renderDiagram`/`drawDiagram` (lazy, one render queue, cached by source and theme, sanitized, the same
// configuration and security level). A block is drawn while no selection touches it; touched, its source shows
// and the drawing stays below it.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { frontMatterEnd, type Span, touches } from "./live-preview-core.ts";
import { findMathBlocks, type MathBlock } from "./live-preview-math.ts";
import { drawDiagram, renderDiagram } from "./mermaid";
import { texToHtml } from "./math";

// ---------------------------------------------------------------- widgets

/** Sizes of what was drawn, so a widget made again (scrolling) reserves its space and the page does not jump. */
const heights = new Map<string, number>();
function rememberHeight(key: string, el: HTMLElement) {
  const height = el.getBoundingClientRect().height;
  if (height <= 0) return;
  if (heights.size > 300) heights.clear();
  heights.set(key, height);
}

/** A click on a formula or diagram goes to the editor (it puts the cursor next to it), not to the widget. */
abstract class DrawnWidget extends WidgetType {
  ignoreEvent() {
    return false;
  }
}

/** A formula: inline (`$x$`), or a block of display math. Shows the source until KaTeX has been loaded. */
export class MathWidget extends DrawnWidget {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** A block (its own line or lines) and not a span in the text. */
    readonly block: boolean,
    /** Drawn below the source that is being edited. */
    readonly below = false,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display && other.block === this.block && other.below === this.below;
  }
  get estimatedHeight() {
    return this.block ? (heights.get(`m${this.tex}`) ?? 48) : -1;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.block ? "div" : "span");
    this.fill(el, view);
    return el;
  }
  private fill(el: HTMLElement, view: EditorView) {
    const base = `cm-lp-math math ${this.block ? "math-block cm-lp-math-block" : "math-inline"}${this.below ? " cm-lp-below" : ""}`;
    const result = texToHtml(this.tex, this.display, () => {
      // KaTeX arrived: draw the formula in the element that shows the source (if it is still in use).
      this.fill(el, view);
      view.requestMeasure();
    });
    el.removeAttribute("title");
    if (result.kind === "ok") {
      el.className = base;
      el.innerHTML = result.html;
    } else if (result.kind === "error") {
      el.className = `${base} math-error`;
      el.title = result.message;
      el.textContent = this.tex;
    } else {
      el.className = `${base} math-pending`;
      el.textContent = this.tex;
    }
    if (this.block) requestAnimationFrame(() => el.isConnected && rememberHeight(`m${this.tex}`, el));
  }
}

/** Everything that draws a diagram is told when the theme changes (the preview listens to the same event). */
const diagrams = new Map<HTMLElement, () => void>();
let themeListening = false;
function listenForTheme() {
  if (themeListening) return;
  themeListening = true;
  window.addEventListener("kladde-theme", () => {
    for (const redraw of [...diagrams.values()]) redraw();
  });
}

/** The newest render of each element wins: an older answer that arrives late is dropped. */
const generation = new WeakMap<HTMLElement, number>();

export class DiagramWidget extends DrawnWidget {
  constructor(
    readonly source: string,
    readonly below = false,
  ) {
    super();
  }
  eq(other: DiagramWidget) {
    return other.source === this.source && other.below === this.below;
  }
  get estimatedHeight() {
    return heights.get(`d${this.source}`) ?? 160;
  }
  toDOM(view: EditorView) {
    listenForTheme();
    const el = document.createElement("div");
    el.className = `cm-lp-diagram${this.below ? " cm-lp-below" : ""}`;
    el.style.minHeight = `${this.estimatedHeight}px`;
    el.textContent = "Drawing diagram…";
    this.draw(el, view);
    return el;
  }
  /** The element is reused for another diagram at the same place: it keeps showing the old drawing meanwhile. */
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (!dom.classList.contains("cm-lp-diagram") || dom.classList.contains("cm-lp-below") !== this.below) return false;
    this.draw(dom, view);
    return true;
  }
  destroy(dom: HTMLElement) {
    diagrams.delete(dom);
    generation.delete(dom);
  }
  private draw(el: HTMLElement, view: EditorView) {
    const mine = (generation.get(el) ?? 0) + 1;
    generation.set(el, mine);
    diagrams.set(el, () => this.draw(el, view));
    void renderDiagram(this.source).then((result) => {
      if (generation.get(el) !== mine) return;
      const drawn = document.createElement("div");
      drawDiagram(drawn, result);
      el.replaceChildren(drawn);
      el.style.minHeight = "";
      requestAnimationFrame(() => el.isConnected && rememberHeight(`d${this.source}`, el));
      view.requestMeasure();
    });
  }
}

// ---------------------------------------------------------------- the field

/** The blocks of the document; recomputed when the text or the syntax tree changes. */
export const blocksField = StateField.define<MathBlock[]>({
  create: (state) => findMathBlocks(state.doc, syntaxTree(state), frontMatterEnd(state.doc)),
  update(value, tr) {
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) return value;
    return findMathBlocks(tr.state.doc, syntaxTree(tr.state), frontMatterEnd(tr.state.doc));
  },
});

/**
 * Sent by the plugin when a mouse button goes down (the selection to keep showing) and when it is released (null).
 * While a button is held the blocks neither open nor close under the pointer.
 */
export const holdSelection = StateEffect.define<Span[] | null>();

interface Drawn {
  blocks: readonly MathBlock[];
  held: readonly Span[] | null;
  set: DecorationSet;
}

const sourceLine = Decoration.line({ class: "cm-lp-mathsrc" });

function build(blocks: readonly MathBlock[], selection: readonly Span[], doc: Text): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const b of blocks) {
    const widget = (below: boolean) =>
      b.kind === "mermaid" ? new DiagramWidget(b.source, below) : new MathWidget(b.source, true, true, below);
    if (!touches(selection, b.from, b.to)) {
      ranges.push(Decoration.replace({ widget: widget(false), block: true }).range(b.from, b.to));
      continue;
    }
    // The source shows (display math shaded like code, a fence by the plugin's code block lines), the drawing below.
    if (b.kind === "display") {
      for (let pos = b.from; ; ) {
        const line = doc.lineAt(pos);
        ranges.push(sourceLine.range(line.from));
        if (line.to >= b.to) break;
        pos = line.to + 1;
      }
    }
    ranges.push(Decoration.widget({ widget: widget(true), block: true, side: 1 }).range(b.to));
  }
  return Decoration.set(ranges, true);
}

const decorationField = StateField.define<Drawn>({
  create: (state) => ({ blocks: state.field(blocksField), held: null, set: build(state.field(blocksField), state.selection.ranges, state.doc) }),
  update(value, tr) {
    let held = value.held;
    if (held && tr.docChanged) held = held.map((r) => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }));
    let changed = held !== value.held;
    for (const effect of tr.effects) {
      if (effect.is(holdSelection)) {
        held = effect.value;
        changed = true;
      }
    }
    const blocks = tr.state.field(blocksField);
    if (!changed && blocks === value.blocks && (held || !tr.selection)) return value;
    return { blocks, held, set: build(blocks, held ?? tr.state.selection.ranges, tr.state.doc) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.set),
});

const theme = EditorView.theme({
  ".cm-lp-math-block, .cm-lp-diagram": { overflowX: "auto", overflowY: "hidden", padding: "0.4em 0" },
  ".cm-lp-math-block": { textAlign: "center" },
  ".cm-lp-diagram": { textAlign: "center" },
  ".cm-lp-diagram svg": { maxWidth: "100%", height: "auto" },
  ".cm-lp-below": { borderTop: "1px dashed var(--border)", opacity: "0.9", marginTop: "0.2em" },
  ".cm-lp-math-inline, .cm-lp-math.math-inline": { display: "inline-block", maxWidth: "100%", verticalAlign: "baseline" },
  ".cm-lp-math.math-pending": { fontFamily: "var(--editor-font)", color: "var(--fg-dim)" },
  ".cm-lp-math.math-error": { fontFamily: "var(--editor-font)", color: "var(--error)", cursor: "help" },
  ".cm-lp-math-src": { fontFamily: "var(--editor-font)" },
  ".cm-line.cm-lp-mathsrc": { backgroundColor: "var(--bg-alt)", paddingLeft: "12px", paddingRight: "12px" },
  ".cm-lp-diagram .mermaid-block": { textAlign: "center" },
  ".cm-lp-diagram .mermaid-error": {
    textAlign: "left",
    boxSizing: "border-box",
    maxWidth: "100%",
    padding: "8px 12px",
    border: "1px solid var(--error)",
    borderRadius: "6px",
    backgroundColor: "var(--bg-alt)",
  },
  ".cm-lp-diagram .mermaid-error strong": { color: "var(--error)" },
  ".cm-lp-diagram .mermaid-error pre": {
    margin: "4px 0 0",
    padding: "0",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontFamily: "var(--editor-font)",
    fontSize: "0.85em",
  },
});

/** The state side of formulas and diagrams. */
export const blockExtension: Extension = [blocksField, decorationField, theme];
