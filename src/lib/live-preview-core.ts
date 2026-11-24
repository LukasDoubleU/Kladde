// Live Preview of Markdown, the pure part: from the document, its syntax tree and the selection to a list of
// decoration specs (what to style, hide or draw instead). No DOM and no CodeMirror view: unit tests run it in Node,
// and `live-preview.ts` turns the specs into decorations.
//
// The reveal rule (like Obsidian's Live Preview): the text is always the raw Markdown; the markup characters are
// only hidden while no selection touches the element.
// - Inline elements (emphasis, strikethrough, inline code, links, images, escapes, task boxes, bullets) show their
//   marks while any selection range touches the element: `from <= element.to && to >= element.from`.
// - Block markers (heading `#`, quote `>`, a rule) show per line while a selection touches that line; fences while a
//   selection is anywhere in the code block.
// Every selection range counts, so each cursor of a multi-cursor selection reveals its own elements.

import type { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { MathBlock } from "./live-preview-math.ts";
import { scanInlineMath } from "./math-scan.ts";

export interface Span {
  from: number;
  to: number;
}

/** What is drawn instead of hidden or replaced text. Plain data: the DOM is made by `live-preview.ts`. */
export type WidgetData =
  | { type: "bullet"; depth: number }
  /**
   * `offset`: distance from the start of the replaced text to the `[` of the marker (`- [ ]` is 2). `editable`:
   * false in a read-only tab, where a click changes nothing.
   */
  | { type: "checkbox"; checked: boolean; offset: number; editable: boolean }
  | { type: "hr" }
  /** An inline formula (`$x$`, or `$$x$$` inside a paragraph, which is `display`). */
  | { type: "math"; tex: string; display: boolean }
  /** `src` is the address as written in the document; the extension resolves it. `editing`: the markup is shown. */
  | { type: "image"; alt: string; src: string; editing: boolean };

export type LiveSpec =
  /** A class on a stretch of text. */
  | { kind: "mark"; from: number; to: number; cls: string }
  /** A class on a line: `from` is the start of the line. */
  | { kind: "line"; from: number; to: number; cls: string }
  /** Text that is not shown. */
  | { kind: "hide"; from: number; to: number }
  /** Text that is replaced by a widget (`from < to`), or a widget placed at a position (`from === to`). */
  | { kind: "widget"; from: number; to: number; widget: WidgetData };

export interface LiveInput {
  doc: Text;
  tree: Tree;
  /** All selection ranges (cursors have `from === to`). */
  selection: readonly Span[];
  /** The parts of the document to decorate (the visible ranges of the view). */
  visible: readonly Span[];
  /**
   * The display math, math fences and diagrams of the document (`findMathBlocks`, kept by a state field: they are drawn
   * as block widgets, which a view plugin cannot do). Nothing is decorated inside the ones that are drawn.
   */
  blocks?: readonly MathBlock[];
  /** False in a read-only tab: the task boxes are drawn as not clickable and do nothing when clicked. */
  editable: boolean;
}

const HEADINGS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const KIND_ORDER = { line: 0, widget: 1, hide: 2, mark: 3 } as const;

/** Whether any selection range touches `from..to` (the ends count: a cursor right behind `**b**` reveals it). */
export function touches(selection: readonly Span[], from: number, to: number): boolean {
  for (const r of selection) if (r.from <= to && r.to >= from) return true;
  return false;
}

/**
 * The end (end of the closing line) of a YAML front matter block at the start of the document, or -1. Lezer reads
 * `---`, `title: x`, `---` as a rule and a heading, which must not be drawn as such.
 */
export function frontMatterEnd(doc: Text): number {
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== "---" || !/^[\w-]+\s*:/.test(doc.line(2).text)) return -1;
  const last = Math.min(doc.lines, 200);
  for (let n = 3; n <= last; n++) {
    const text = doc.line(n).text.trimEnd();
    if (text === "---" || text === "...") return doc.line(n).to;
  }
  return -1;
}

/** The address of an image as written, without the `<…>` of a target with spaces. */
function unangle(url: string): string {
  return url.startsWith("<") && url.endsWith(">") ? url.slice(1, -1) : url;
}

/** Nodes in which a `$` does not start a formula (the rest of the inline rules of markdown-it are in math-scan.ts). */
const NOT_INLINE_MATH = new Set([
  "InlineCode", "CodeText", "FencedCode", "CodeBlock", "HTMLBlock", "HTMLTag", "CommentBlock", "Comment",
  "ProcessingInstructionBlock", "URL", "LinkTitle", "Autolink", "Table",
]);

function mathAllowedAt(tree: Tree, pos: number): boolean {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (NOT_INLINE_MATH.has(node.name)) return false;
  }
  return true;
}

export function buildLivePreview({ doc, tree, selection, visible, editable, blocks = [] }: LiveInput): LiveSpec[] {
  const specs: LiveSpec[] = [];
  const seen = new Set<string>();
  const skipUntil = frontMatterEnd(doc);

  // Where nothing else is decorated: the formulas themselves (touched or not: their source is plain text), display
  // math (also while its source shows), and the fences and diagrams that are drawn.
  const owned: Span[] = blocks.filter((b) => b.kind === "display" || !touches(selection, b.from, b.to));
  const inOwned = (from: number, to: number) => owned.some((s) => from >= s.from && to <= s.to);

  for (const range of visible) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (line.from < skipUntil || !line.text.includes("$")) continue;
      for (const m of scanInlineMath(line.text)) {
        const from = line.from + m.from;
        const to = line.from + m.end;
        if (blocks.some((b) => from >= b.from && to <= b.to) || tree.length < to || !mathAllowedAt(tree, from)) continue;
        owned.push({ from, to });
        const key = `math:${from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        specs.push(
          touches(selection, from, to)
            ? { kind: "mark", from, to, cls: "cm-lp-math-src" }
            : { kind: "widget", from, to, widget: { type: "math", tex: m.content, display: m.display } },
        );
      }
    }
  }

  const add = (spec: LiveSpec) => {
    if (inOwned(spec.from, spec.to)) return;
    // A node that spans several visible ranges is visited once per range.
    const key = `${spec.kind}:${spec.from}:${spec.to}:${spec.kind === "mark" || spec.kind === "line" ? spec.cls : spec.kind === "widget" ? spec.widget.type : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(spec);
  };
  const mark = (from: number, to: number, cls: string) => from < to && add({ kind: "mark", from, to, cls });
  /** Hides a stretch of one line (a replacement may not contain a line break). */
  const hide = (from: number, to: number) => {
    if (from < to && doc.lineAt(from).to >= to) add({ kind: "hide", from, to });
  };
  const replace = (from: number, to: number, widget: WidgetData) => {
    if (from < to && doc.lineAt(from).to >= to) add({ kind: "widget", from, to, widget });
  };
  /** Line decorations for the lines of `from..to` that are in view. */
  const lines = (from: number, to: number, range: Span, cls: (lineFrom: number) => string | null) => {
    let pos = Math.max(from, range.from);
    const end = Math.min(to, range.to);
    for (;;) {
      const line = doc.lineAt(pos);
      const c = cls(line.from);
      if (c) add({ kind: "line", from: line.from, to: line.from, cls: c });
      if (line.to >= end || line.number >= doc.lines) break;
      pos = line.to + 1;
    }
  };
  const lineTouched = (pos: number) => {
    const line = doc.lineAt(pos);
    return touches(selection, line.from, line.to);
  };
  const depthOf = (node: SyntaxNode, name: string) => {
    let depth = 0;
    for (let p: SyntaxNode | null = node; p; p = p.parent) if (p.name === name) depth++;
    return depth;
  };

  for (const range of visible) {
    let quoteDepth = 0;
    /** Per line start: the deepest blockquote level, drawn after the walk so nested quotes give one decoration. */
    const quoteLines = new Map<number, number>();

    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        if (ref.name === "Document") return;
        if (ref.from < skipUntil) return false;
        const name = ref.name;
        const heading = HEADINGS[name];

        if (heading) {
          const node = ref.node;
          const last = doc.lineAt(ref.to);
          const underline = name.startsWith("Setext") ? last.from : -1;
          lines(ref.from, ref.to, range, (lineFrom) => (lineFrom === underline ? "cm-lp-setext-mark" : `cm-lp-h${heading}`));
          for (const m of node.getChildren("HeaderMark")) {
            const line = doc.lineAt(m.from);
            if (touches(selection, line.from, line.to)) continue;
            if (underline >= 0) hide(m.from, m.to);
            else if (m.from === ref.from) hide(m.from, doc.sliceString(m.to, m.to + 1) === " " ? m.to + 1 : m.to);
            else {
              // The closing `##` and the space before it.
              let start = m.from;
              while (start > line.from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
              hide(start, m.to);
            }
          }
          return;
        }

        switch (name) {
          case "StrongEmphasis":
          case "Emphasis":
          case "Strikethrough": {
            mark(ref.from, ref.to, name === "StrongEmphasis" ? "cm-lp-strong" : name === "Emphasis" ? "cm-lp-em" : "cm-lp-strike");
            if (!touches(selection, ref.from, ref.to)) {
              const markName = name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark";
              for (const m of ref.node.getChildren(markName)) hide(m.from, m.to);
            }
            return;
          }
          case "InlineCode": {
            const marks = ref.node.getChildren("CodeMark");
            // The marks are hidden, so the shaded part is only the code (padding comes from the stylesheet).
            mark(ref.from, ref.to, "cm-lp-code");
            if (!touches(selection, ref.from, ref.to)) for (const m of marks) hide(m.from, m.to);
            return false;
          }
          case "Link": {
            const node = ref.node;
            const marks = node.getChildren("LinkMark");
            // Reference links (`[a][b]`, `[a]`) have no address of their own: left as they are.
            if (marks.length < 4 || !node.getChild("URL")) return;
            const open = marks[0];
            const close = marks[1];
            if (open.to >= close.from) return;
            mark(open.to, close.from, "cm-lp-link");
            if (!touches(selection, ref.from, ref.to)) {
              hide(open.from, open.to);
              hide(close.from, ref.to);
            }
            return;
          }
          case "Autolink": {
            const marks = ref.node.getChildren("LinkMark");
            const url = ref.node.getChild("URL");
            if (marks.length < 2 || !url) return false;
            mark(url.from, url.to, "cm-lp-link");
            if (!touches(selection, ref.from, ref.to)) {
              hide(marks[0].from, marks[0].to);
              hide(marks[marks.length - 1].from, marks[marks.length - 1].to);
            }
            return false;
          }
          case "URL": {
            // A bare address (GitHub's autolink literal); the addresses of links and images are hidden with them.
            const parent = ref.node.parent?.name;
            if (parent !== "Link" && parent !== "Image" && parent !== "Autolink") mark(ref.from, ref.to, "cm-lp-link");
            return false;
          }
          case "Image": {
            const node = ref.node;
            const marks = node.getChildren("LinkMark");
            const url = node.getChild("URL");
            if (marks.length < 4 || !url || doc.lineAt(ref.from).to < ref.to) return false;
            const alt = doc.sliceString(marks[0].to, marks[1].from);
            const src = unangle(doc.sliceString(url.from, url.to));
            if (touches(selection, ref.from, ref.to)) {
              // The markup is shown for editing; the picture stays, behind it.
              add({ kind: "widget", from: ref.to, to: ref.to, widget: { type: "image", alt, src, editing: true } });
            } else {
              replace(ref.from, ref.to, { type: "image", alt, src, editing: false });
            }
            return false;
          }
          case "Escape": {
            if (!touches(selection, ref.from, ref.to)) hide(ref.from, ref.from + 1);
            return false;
          }
          case "ListMark": {
            const item = ref.node.parent;
            const list = item?.parent;
            if (!item || !list) return;
            if (list.name === "OrderedList") {
              mark(ref.from, ref.to, "cm-lp-list-num");
              return false;
            }
            // A task item is drawn as its checkbox (see TaskMarker).
            if (item.getChild("Task")) return false;
            const line = doc.lineAt(ref.from);
            if (!touches(selection, ref.from, Math.min(ref.to + 1, line.to))) {
              replace(ref.from, ref.to, { type: "bullet", depth: Math.max(1, depthOf(item, "BulletList") + depthOf(item, "OrderedList")) });
            }
            return false;
          }
          case "TaskMarker": {
            const text = doc.sliceString(ref.from, ref.to);
            const checked = /x/i.test(text);
            const item = ref.node.parent?.parent;
            const list = item?.parent;
            const bullet = item?.name === "ListItem" && list?.name === "BulletList" ? item.getChild("ListMark") : null;
            const start = bullet ? bullet.from : ref.from;
            const line = doc.lineAt(ref.from);
            if (!touches(selection, start, Math.min(ref.to + 1, line.to))) {
              replace(start, ref.to, { type: "checkbox", checked, offset: ref.from - start, editable });
            }
            return false;
          }
          case "Task": {
            const marker = ref.node.getChild("TaskMarker");
            if (marker && /x/i.test(doc.sliceString(marker.from, marker.to))) mark(marker.to, ref.to, "cm-lp-task-done");
            return;
          }
          case "Blockquote": {
            quoteDepth++;
            lines(ref.from, ref.to, range, (lineFrom) => {
              quoteLines.set(lineFrom, Math.max(quoteLines.get(lineFrom) ?? 0, quoteDepth));
              return null;
            });
            return;
          }
          case "QuoteMark": {
            if (!lineTouched(ref.from)) hide(ref.from, doc.sliceString(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to);
            return false;
          }
          case "HorizontalRule": {
            if (!lineTouched(ref.from)) replace(ref.from, ref.to, { type: "hr" });
            return false;
          }
          case "FencedCode": {
            const first = doc.lineAt(ref.from);
            const lastLine = doc.lineAt(ref.to);
            const closed = ref.node.getChildren("CodeMark").length >= 2;
            const active = touches(selection, ref.from, ref.to);
            lines(ref.from, ref.to, range, (lineFrom) => {
              let cls = "cm-lp-codeblock";
              if (lineFrom === first.from) cls += " cm-lp-codeblock-first";
              if (lineFrom === lastLine.from) cls += " cm-lp-codeblock-last";
              if (!active && (lineFrom === first.from || (closed && lineFrom === lastLine.from))) cls += " cm-lp-fence";
              return cls;
            });
            // The code itself keeps its nested highlighting: the children are not walked.
            return false;
          }
          case "CodeBlock": {
            const first = doc.lineAt(ref.from);
            const lastLine = doc.lineAt(ref.to);
            lines(ref.from, ref.to, range, (lineFrom) => {
              let cls = "cm-lp-codeblock";
              if (lineFrom === first.from) cls += " cm-lp-codeblock-first";
              if (lineFrom === lastLine.from) cls += " cm-lp-codeblock-last";
              return cls;
            });
            return false;
          }
          // Tables stay raw Markdown, cells included: hiding `**` in a cell would shift the pipes out of line.
          case "Table":
          case "HTMLBlock":
          case "CommentBlock":
          case "ProcessingInstructionBlock":
            return false;
        }
      },
      leave: (ref) => {
        if (ref.name === "Blockquote") quoteDepth--;
      },
    });

    for (const [lineFrom, depth] of quoteLines) {
      add({ kind: "line", from: lineFrom, to: lineFrom, cls: `cm-lp-quote cm-lp-quote-${Math.min(depth, 3)}` });
    }
  }

  return specs.sort(
    (a, b) => a.from - b.from || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.to - b.to,
  );
}
