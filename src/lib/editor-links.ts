// Links in the editor: Ctrl+click opens the link under the mouse, and while Ctrl is held that link is underlined
// and shows a hand. Nothing here looks at the whole document: only the line under the mouse is searched, on a
// mouse move with Ctrl held and on a click.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type LinkSpan, linkAt } from "./links";

export interface LinkHost {
  /** Whether the link syntax of Markdown applies to the document in the editor. */
  isMarkdown(): boolean;
  /** Opens the target of a link found in the document. */
  open(href: string): void;
}

interface Found extends LinkSpan {
  /** Document offsets. */
  docFrom: number;
  docTo: number;
}

/** Node names of the Markdown parser in which `[a](b)` is code, not a link. */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText"]);

function inMarkdownCode(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 0); node.parent; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

/** The link at a document position, or null. */
export function linkAtPos(state: EditorState, pos: number, markdown: boolean): Found | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  let link = linkAt(line.text, offset, markdown);
  // `[a](b)` in a code span or block is code; a bare URL there still counts. The tree is only asked when needed.
  if (link && markdown && (line.text[link.from] === "[" || line.text[link.from] === "!") && inMarkdownCode(state, pos)) {
    link = linkAt(line.text, offset, false);
  }
  return link && { ...link, docFrom: line.from + link.from, docTo: line.from + link.to };
}

/** Only wakes the view up after the plugin changed its decorations. */
const refresh = StateEffect.define<null>();
const hoverMark = Decoration.mark({ class: "cm-link-hover" });

/** The link under a mouse position, if the pointer really is over its characters. */
function linkUnderMouse(view: EditorView, x: number, y: number, markdown: boolean): Found | null {
  const pos = view.posAtCoords({ x, y }, false);
  if (pos === null) return null;
  const link = linkAtPos(view.state, pos, markdown);
  if (!link) return null;
  // A position at either end of the link is also what the first character after or before it gives.
  if (pos === link.docTo) {
    const edge = view.coordsAtPos(pos, -1);
    if (!edge || x > edge.right + 1 || y < edge.top || y > edge.bottom) return null;
  } else if (pos === link.docFrom) {
    const edge = view.coordsAtPos(pos, 1);
    if (!edge || x < edge.left - 1 || y < edge.top || y > edge.bottom) return null;
  } else {
    // The position is inside the link, but the pointer may be far below the last line or beside a short line.
    const box = view.coordsAtPos(pos);
    if (!box || y < box.top - 1 || y > box.bottom + 1) return null;
  }
  return link;
}

export function linkExtension(host: LinkHost) {
  const plugin = ViewPlugin.fromClass(
    class {
      /** Last mouse position over the editor, to underline when Ctrl is pressed with a still mouse. */
      mouse: { x: number; y: number } | null = null;
      hovered: { from: number; to: number } | null = null;
      /** The one underlined link. Held by the plugin, not the state, so it never outlives a tab switch. */
      deco: DecorationSet = Decoration.none;

      constructor(readonly view: EditorView) {
        window.addEventListener("keydown", this.onKey);
        window.addEventListener("keyup", this.onKey);
        window.addEventListener("blur", this.clear);
      }

      destroy() {
        window.removeEventListener("keydown", this.onKey);
        window.removeEventListener("keyup", this.onKey);
        window.removeEventListener("blur", this.clear);
      }

      onKey = (e: KeyboardEvent) => {
        if (e.key !== "Control") return;
        if (e.type === "keydown" && this.mouse) this.show(this.mouse.x, this.mouse.y);
        else this.clear();
      };

      update(update: ViewUpdate) {
        if (update.docChanged && this.hovered) {
          this.hovered = null;
          this.deco = Decoration.none;
        }
      }

      clear = () => {
        if (!this.hovered) return;
        this.hovered = null;
        this.deco = Decoration.none;
        this.view.dispatch({ effects: refresh.of(null) });
      };

      show(x: number, y: number) {
        const link = linkUnderMouse(this.view, x, y, host.isMarkdown());
        if (!link) return this.clear();
        if (this.hovered?.from === link.docFrom && this.hovered.to === link.docTo) return;
        this.hovered = { from: link.docFrom, to: link.docTo };
        this.deco = Decoration.set(hoverMark.range(link.docFrom, link.docTo));
        this.view.dispatch({ effects: refresh.of(null) });
      }

      move(e: MouseEvent) {
        this.mouse = { x: e.clientX, y: e.clientY };
        if (e.ctrlKey && !e.altKey) this.show(e.clientX, e.clientY);
        else this.clear();
      }

      leave() {
        this.mouse = null;
        this.clear();
      }

      /** Ctrl+click on a link opens it; the click is then not a selection (no cursor added, nothing moved). */
      down(e: MouseEvent): boolean {
        if (e.button !== 0 || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
        const link = linkUnderMouse(this.view, e.clientX, e.clientY, host.isMarkdown());
        if (!link) return false;
        this.clear();
        host.open(link.href);
        return true;
      }
    },
    {
      decorations: (plugin) => plugin.deco,
      eventHandlers: {
        mousemove(e) {
          this.move(e);
        },
        mouseleave() {
          this.leave();
        },
        mousedown(e) {
          return this.down(e);
        },
      },
    },
  );
  return plugin;
}
