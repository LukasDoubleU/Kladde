// The blocks of a Markdown document that Live Preview draws as one unit across lines: display math (`$$ … $$`, one
// line or several), ```math fences and ```mermaid fences. Pure: from the document and its syntax tree to ranges, so
// Node can test it. The editor turns the ranges into block widgets in a state field (live-preview.ts); a widget
// that replaces line breaks may not come from a view plugin.
//
// Why a scan and not a Lezer extension: an extra parser changes the syntax tree that highlighting, the grammar
// checker's masking (grammar-text.ts), the link finder and Live Preview itself read. Display math is found by the
// same rules as the preview (math-scan.ts) on the lines of the document, and only where the tree says the line is
// not code, HTML, a table or a quotation. Fences come from the tree's own FencedCode nodes.

import type { Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { matchDisplayBlock } from "./math-scan.ts";

export interface MathBlock {
  /** `display`: `$$ … $$`; `mathfence`: a ```math fence; `mermaid`: a ```mermaid fence. */
  kind: "display" | "mathfence" | "mermaid";
  /** The start of the first line and the end of the last line of the block. */
  from: number;
  to: number;
  /** The TeX, or the diagram's source (with the line break at its end, as the preview gives it to Mermaid). */
  source: string;
}

/** Nodes in which a line that starts with `$$` is not display math. */
const NOT_MATH = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock", "Table", "Blockquote"]);

/** The containers whose fences are found (a fence at the top of a list item counts, one in a quotation does not). */
const CONTAINERS = new Set(["Document", "BulletList", "OrderedList", "ListItem"]);

export function findMathBlocks(doc: Text, tree: Tree, skipUntil = -1): MathBlock[] {
  const blocks: MathBlock[] = [];

  // Fences: only closed ones, and only when nothing but white space comes before the fence on its line. An unclosed
  // fence would turn the rest of the document into a diagram while its opening line is being typed.
  tree.iterate({
    enter: (ref) => {
      if (CONTAINERS.has(ref.name)) return;
      if (ref.name === "FencedCode" && ref.from >= skipUntil) {
        const node = ref.node;
        const info = node.getChild("CodeInfo");
        const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLowerCase() : "";
        const first = doc.lineAt(ref.from);
        const text = node.getChild("CodeText");
        if ((lang === "math" || lang === "mermaid") && node.getChildren("CodeMark").length >= 2 && text && /^\s*$/.test(doc.sliceString(first.from, ref.from))) {
          const source = doc.sliceString(text.from, text.to);
          if (source.trim()) {
            blocks.push({ kind: lang === "math" ? "mathfence" : "mermaid", from: first.from, to: doc.lineAt(ref.to).to, source: lang === "math" ? source.trim() : source + "\n" });
          }
        }
      }
      return false;
    },
  });

  // Display math: the lines that start with `$$`.
  const count = doc.lines;
  const lineText = (index: number) => doc.line(index + 1).text;
  let skipLine = 0;
  for (let index = 0, pos = 0, text = ""; index < count; index++, pos += text.length + 1) {
    text = lineText(index);
    if (index < skipLine || !text.includes("$$") || pos < skipUntil) continue;
    const found = matchDisplayBlock(lineText, count, index);
    if (!found) continue;
    const to = doc.line(found.last + 1).to;
    // Only where the parser has got to, and not in code, HTML, a table or a quotation.
    if (tree.length < to || insideNotMath(tree, pos + text.search(/\S/))) continue;
    if (blocks.some((b) => b.from <= to && b.to >= pos)) continue;
    blocks.push({ kind: "display", from: pos, to, source: found.content.trim() });
    skipLine = found.last + 1;
  }

  return blocks.sort((a, b) => a.from - b.from);
}

function insideNotMath(tree: Tree, pos: number): boolean {
  for (let node: { name: string; parent: unknown } | null = tree.resolveInner(pos, 1); node; node = node.parent as typeof node) {
    if (NOT_MATH.has(node.name)) return true;
  }
  return false;
}
