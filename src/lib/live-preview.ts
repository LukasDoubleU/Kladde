// Live Preview of Markdown in the editor: the text stays the raw Markdown, but it is shown formatted while you edit
// it. Which ranges are hidden, styled or drawn instead is decided by `live-preview-core.ts` (pure, unit-tested); this
// file turns that into decorations, draws the widgets (bullets, task boxes, rules, images), keeps the view in step
// with the selection and holds the theme.
//
// It is a view only: nothing here changes the document, except a click on a task box (one undoable change).

import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type Extension, Facet, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { buildLivePreview, type LiveSpec, type Span, type WidgetData } from "./live-preview-core";
import { localImagePath } from "./links";
import { blockExtension, blocksField, holdSelection, MathWidget } from "./live-preview-blocks";

/** The folder of the Markdown file (null: untitled), for the relative addresses of images. */
const baseDir = Facet.define<string | null, string | null>({ combine: (values) => values[0] ?? null });

/** Wakes the plugin up without a change: after a mouse button was released, or the folder changed. */
const refresh = StateEffect.define<null>();

// ---------------------------------------------------------------- widgets

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(other: BulletWidget) {
    return other.depth === this.depth;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-bullet";
    el.textContent = this.depth <= 1 ? "•" : this.depth === 2 ? "◦" : "▪";
    return el;
  }
}

/** Toggles the box whose widget is `dom`: one change of one character, as its own undo step. */
function toggleTask(view: EditorView, dom: HTMLElement, offset: number) {
  if (view.state.readOnly || !view.state.facet(EditorView.editable)) return;
  const at = view.posAtDOM(dom) + offset;
  const marker = /^\[([ xX])\]$/.exec(view.state.sliceDoc(at, at + 3));
  if (!marker) return;
  // No selection in the transaction: the cursor stays where it is, the click never moves it into the line.
  view.dispatch({
    changes: { from: at + 1, to: at + 2, insert: marker[1] === " " ? "x" : " " },
    annotations: isolateHistory.of("full"),
    userEvent: "input.toggletask",
  });
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly offset: number,
    readonly editable: boolean,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.offset === this.offset && other.editable === this.editable;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-lp-task" + (this.editable ? "" : " cm-lp-task-readonly");
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    // The mouse down must neither focus anything nor start a selection; the click toggles.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTask(view, el, this.offset);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-hr";
    return el;
  }
}

/** Sizes of images that were shown, so a widget made again (a tab switch) reserves its space at once. */
const knownSizes = new Map<string, { w: number; h: number }>();

class ImageWidget extends WidgetType {
  constructor(
    /** What the page loads; null when the address cannot be shown (the alt text takes its place). */
    readonly url: string | null,
    readonly alt: string,
    readonly editing: boolean,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.url === this.url && other.alt === this.alt && other.editing === this.editing;
  }
  get estimatedHeight() {
    const size = this.url ? knownSizes.get(this.url) : undefined;
    return size ? Math.min(size.h, this.editing ? 96 : 384) : -1;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-img" + (this.editing ? " cm-lp-img-editing" : "");
    const broken = () => {
      wrap.className += " cm-lp-img-broken";
      wrap.textContent = `[${this.alt || "image"}]`;
    };
    if (!this.url) {
      broken();
      return wrap;
    }
    const img = document.createElement("img");
    img.alt = this.alt;
    img.draggable = false;
    const known = knownSizes.get(this.url);
    if (known) {
      img.width = known.w;
      img.height = known.h;
    }
    img.addEventListener("load", () => {
      if (knownSizes.size > 300) knownSizes.clear();
      knownSizes.set(this.url!, { w: img.naturalWidth, h: img.naturalHeight });
      view.requestMeasure();
    });
    img.addEventListener("error", () => {
      wrap.textContent = "";
      broken();
      view.requestMeasure();
    });
    img.src = this.url;
    wrap.append(img);
    return wrap;
  }
}

/**
 * What the page loads for an image address, by the rules of the preview: a web address (https; the CSP of the main
 * window lets exactly these and `data:` images through) as it is, a local path relative to the file through the asset
 * protocol. Everything else, and a relative path of an untitled tab, has no picture.
 */
export function imageUrl(src: string, folder: string | null): string | null {
  if (/^https:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
  if (/^[a-z][a-z0-9+.-]+:/i.test(src) || src.startsWith("//")) return null;
  const path = localImagePath(src.trim(), folder);
  return path ? convertFileSrc(path) : null;
}

function widgetFor(data: WidgetData, folder: string | null) {
  switch (data.type) {
    case "bullet":
      return new BulletWidget(data.depth);
    case "checkbox":
      return new CheckboxWidget(data.checked, data.offset, data.editable);
    case "hr":
      return new RuleWidget();
    case "image":
      return new ImageWidget(imageUrl(data.src, folder), data.alt, data.editing);
    case "math":
      return new MathWidget(data.tex, data.display, false);
  }
}

// ---------------------------------------------------------------- decorations

const hideDeco = Decoration.replace({});
const classDecos = new Map<string, Decoration>();
function cached(cls: string, make: (cls: string) => Decoration): Decoration {
  let deco = classDecos.get(cls);
  if (!deco) classDecos.set(cls, (deco = make(cls)));
  return deco;
}

function toDecorations(specs: readonly LiveSpec[], folder: string | null): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const s of specs) {
    switch (s.kind) {
      case "mark":
        ranges.push(cached(`m:${s.cls}`, () => Decoration.mark({ class: s.cls })).range(s.from, s.to));
        break;
      case "line":
        ranges.push(cached(`l:${s.cls}`, () => Decoration.line({ class: s.cls })).range(s.from));
        break;
      case "hide":
        ranges.push(hideDeco.range(s.from, s.to));
        break;
      case "widget": {
        const widget = widgetFor(s.widget, folder);
        ranges.push(
          (s.from === s.to ? Decoration.widget({ widget, side: 1 }) : Decoration.replace({ widget })).range(s.from, s.to),
        );
        break;
      }
    }
  }
  return Decoration.set(ranges, true);
}

// ---------------------------------------------------------------- the plugin

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** A mouse button is held (a click or a drag): the selection that decides what is revealed stays as it was. */
    frozen: Span[] | null = null;
    /** The selection changed while it was frozen. */
    pending = false;
    release = 0;

    constructor(readonly view: EditorView) {
      this.decorations = this.build(view.state.selection.ranges);
      window.addEventListener("mouseup", this.onUp, true);
      window.addEventListener("blur", this.onUp);
    }

    destroy() {
      window.removeEventListener("mouseup", this.onUp, true);
      window.removeEventListener("blur", this.onUp);
      clearTimeout(this.release);
    }

    build(selection: readonly Span[]): DecorationSet {
      const state = this.view.state;
      const specs = buildLivePreview({
        doc: state.doc,
        tree: syntaxTree(state),
        selection,
        visible: this.view.visibleRanges,
        editable: !state.readOnly && state.facet(EditorView.editable),
        blocks: state.field(blocksField),
      });
      return toDecorations(specs, state.facet(baseDir));
    }

    update(update: ViewUpdate) {
      const state = update.state;
      const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(refresh) || e.is(holdSelection)));
      const rebuild =
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        asked ||
        syntaxTree(update.startState) !== syntaxTree(state) ||
        update.startState.field(blocksField) !== state.field(blocksField) ||
        update.startState.readOnly !== state.readOnly ||
        update.startState.facet(baseDir) !== state.facet(baseDir);
      if (!rebuild) return;
      if (this.frozen) {
        if (update.selectionSet && !update.docChanged && !update.viewportChanged && !asked) {
          this.pending = true;
          return;
        }
        this.frozen = this.frozen.map((r) => ({ from: update.changes.mapPos(r.from, -1), to: update.changes.mapPos(r.to, 1) }));
        this.decorations = this.build(this.frozen);
        return;
      }
      this.decorations = this.build(state.selection.ranges);
    }

    down() {
      clearTimeout(this.release);
      if (this.frozen) return;
      this.frozen = this.view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
      // The state field that draws the blocks holds its selection too.
      this.view.dispatch({ effects: holdSelection.of(this.frozen) });
    }

    /** After CodeMirror's own handler of the same event has made its last selection change. */
    onUp = () => {
      if (!this.frozen) return;
      clearTimeout(this.release);
      this.release = window.setTimeout(() => {
        this.frozen = null;
        this.pending = false;
        if (this.view.dom.isConnected) this.view.dispatch({ effects: holdSelection.of(null) });
      }, 0);
    };
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event) {
        if (event.button === 0) this.down();
        return false;
      },
      // A release that never arrived (a drag that ended outside the page): do not stay frozen.
      mousemove(event) {
        if (this.frozen && event.buttons === 0) this.onUp();
        return false;
      },
    },
  },
);

// ---------------------------------------------------------------- the look

const theme = EditorView.theme({
  // Headings: em sizes, so the editor zoom scales them.
  ".cm-line.cm-lp-h1": { fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-line.cm-lp-h2": { fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-line.cm-lp-h3": { fontSize: "1.25em", fontWeight: "700", lineHeight: "1.35" },
  ".cm-line.cm-lp-h4": { fontSize: "1.1em", fontWeight: "700" },
  ".cm-line.cm-lp-h5": { fontSize: "1em", fontWeight: "700" },
  ".cm-line.cm-lp-h6": { fontSize: "0.9em", fontWeight: "700", color: "var(--fg-dim)" },
  ".cm-line.cm-lp-h1, .cm-line.cm-lp-h2": { borderBottom: "1px solid var(--bg-hover)", paddingBottom: "0.1em" },
  ".cm-line[class*='cm-lp-h'] .tok-heading": { color: "inherit" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", color: "var(--fg-dim)" },
  ".cm-lp-code": {
    backgroundColor: "var(--bg-alt)",
    borderRadius: "4px",
    padding: "0.1em 0.25em",
  },
  ".cm-lp-link": { color: "var(--link)" },
  ".cm-lp-list-num": { color: "var(--fg-dim)" },
  ".cm-lp-task-done": { color: "var(--fg-dim)" },
  ".cm-lp-bullet": {
    display: "inline-block",
    width: "1ch",
    textAlign: "center",
    fontSize: "1.3em",
    lineHeight: "1",
    color: "var(--fg-dim)",
  },
  ".cm-lp-task": {
    display: "inline-block",
    position: "relative",
    boxSizing: "border-box",
    width: "1.1em",
    height: "1.1em",
    margin: "0 0.05em",
    verticalAlign: "-0.2em",
    border: "1px solid var(--fg-dim)",
    borderRadius: "3px",
    cursor: "pointer",
  },
  ".cm-lp-task:hover": { borderColor: "var(--accent)" },
  ".cm-lp-task-readonly, .cm-lp-task-readonly:hover": { cursor: "default", borderColor: "var(--fg-dim)" },
  ".cm-lp-task[aria-checked=true]": { borderColor: "var(--accent)", backgroundColor: "var(--accent)" },
  ".cm-lp-task[aria-checked=true]::after": {
    content: '""',
    position: "absolute",
    left: "0.32em",
    top: "0.07em",
    width: "0.25em",
    height: "0.5em",
    border: "solid var(--accent-fg)",
    borderWidth: "0 2px 2px 0",
    transform: "rotate(45deg)",
  },
  ".cm-lp-hr": {
    display: "inline-block",
    boxSizing: "border-box",
    width: "100%",
    height: "0",
    verticalAlign: "middle",
    borderTop: "2px solid var(--bg-hover)",
  },
  // Quotes: a bar per level on the left; the text is dimmed like in the preview.
  ".cm-line.cm-lp-quote": {
    color: "var(--fg-dim)",
    paddingLeft: "18px",
    backgroundRepeat: "no-repeat",
    backgroundSize: "3px 100%",
    backgroundImage: "linear-gradient(var(--fg-dim), var(--fg-dim))",
    backgroundPosition: "6px 0",
  },
  ".cm-line.cm-lp-quote-2": {
    paddingLeft: "30px",
    backgroundImage: "linear-gradient(var(--fg-dim), var(--fg-dim)), linear-gradient(var(--fg-dim), var(--fg-dim))",
    backgroundPosition: "6px 0, 18px 0",
    backgroundSize: "3px 100%, 3px 100%",
  },
  ".cm-line.cm-lp-quote-3": {
    paddingLeft: "42px",
    backgroundImage:
      "linear-gradient(var(--fg-dim), var(--fg-dim)), linear-gradient(var(--fg-dim), var(--fg-dim)), linear-gradient(var(--fg-dim), var(--fg-dim))",
    backgroundPosition: "6px 0, 18px 0, 30px 0",
    backgroundSize: "3px 100%, 3px 100%, 3px 100%",
  },
  // Code blocks: one shaded block, rounded at its ends; the fences are muted while the cursor is elsewhere.
  ".cm-line.cm-lp-codeblock": { backgroundColor: "var(--bg-alt)", paddingLeft: "12px", paddingRight: "12px" },
  ".cm-line.cm-lp-codeblock-first": { borderTopLeftRadius: "6px", borderTopRightRadius: "6px" },
  ".cm-line.cm-lp-codeblock-last": { borderBottomLeftRadius: "6px", borderBottomRightRadius: "6px" },
  ".cm-line.cm-lp-fence": { color: "var(--fg-dim)", opacity: "0.6", fontSize: "0.85em" },
  ".cm-lp-img": { display: "inline-block", maxWidth: "100%", verticalAlign: "bottom" },
  // A picture scaled down by the height limit keeps its box width: drawn at the left of it, not centered in a gap.
  ".cm-lp-img img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "24em",
    objectFit: "contain",
    objectPosition: "left center",
    borderRadius: "3px",
  },
  ".cm-lp-img-editing": { marginLeft: "0.6em", verticalAlign: "middle" },
  ".cm-lp-img-editing img": { maxHeight: "4em", opacity: "0.85" },
  ".cm-lp-img-broken": { color: "var(--fg-dim)", fontStyle: "italic" },
});

/**
 * Live Preview for one Markdown tab. `folder` is the folder of the file, for the relative addresses of images (null:
 * an untitled tab). It lives in a compartment (`editor.ts`), so switching it on and off is a reconfiguration, not a
 * change of the document.
 */
export function livePreview(folder: string | null): Extension {
  return [
    baseDir.of(folder),
    blockExtension,
    livePreviewPlugin,
    theme,
    EditorView.editorAttributes.of({ class: "cm-live-preview" }),
  ];
}
