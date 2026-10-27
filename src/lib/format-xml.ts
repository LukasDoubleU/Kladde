// XML / SVG pretty-printer without dependencies. It only moves whitespace between elements:
// comments, CDATA, processing instructions, the doctype, attribute values and text stay exactly as
// written. Elements with text content (including mixed content) and `xml:space="preserve"` elements
// are copied verbatim, because their whitespace is data.

import type { FormatResult } from "./format.ts";

type Node =
  | { type: "element"; open: Tag; children: Node[]; end: number; selfClosing: boolean }
  | { type: "text"; text: string }
  | { type: "raw"; text: string; cdata: boolean };

type Tag = { name: string; start: number; end: number; source: string };

function position(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const col = offset - before.lastIndexOf("\n");
  return `line ${line}, column ${col}`;
}

class XmlError extends Error {}

/** Index just after the `>` that closes the tag starting at `start`, skipping quoted attribute values. */
function tagEnd(text: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i + 1;
  }
  throw new XmlError(`Unclosed tag (${position(text, start)})`);
}

/** Index just after the doctype's `>`, which may contain an internal subset in brackets. */
function doctypeEnd(text: string, start: number): number {
  let quote = "";
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ">" && depth <= 0) return i + 1;
  }
  throw new XmlError(`Unclosed declaration (${position(text, start)})`);
}

function parse(text: string): Node[] {
  const root: Node[] = [];
  const stack: { tag: Tag; children: Node[] }[] = [];
  const current = () => (stack.length ? stack[stack.length - 1].children : root);
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "<") {
      const next = text.indexOf("<", i);
      const end = next < 0 ? text.length : next;
      current().push({ type: "text", text: text.slice(i, end) });
      i = end;
      continue;
    }
    const raw = (terminator: string, what: string, cdata = false) => {
      const close = text.indexOf(terminator, i);
      if (close < 0) throw new XmlError(`Unclosed ${what} (${position(text, i)})`);
      const end = close + terminator.length;
      current().push({ type: "raw", text: text.slice(i, end), cdata });
      i = end;
    };
    if (text.startsWith("<!--", i)) raw("-->", "comment");
    else if (text.startsWith("<![CDATA[", i)) raw("]]>", "CDATA section", true);
    else if (text.startsWith("<?", i)) raw("?>", "processing instruction");
    else if (text.startsWith("<!", i)) {
      const end = doctypeEnd(text, i);
      current().push({ type: "raw", text: text.slice(i, end), cdata: false });
      i = end;
    } else if (text.startsWith("</", i)) {
      const end = tagEnd(text, i);
      const name = text.slice(i + 2, end - 1).trim();
      const top = stack.pop();
      if (!top) throw new XmlError(`Unexpected </${name}> (${position(text, i)})`);
      if (top.tag.name !== name) {
        throw new XmlError(
          `Expected </${top.tag.name}> but found </${name}> (${position(text, i)}); <${top.tag.name}> opened at ${position(text, top.tag.start)}`,
        );
      }
      const node: Node = { type: "element", open: top.tag, children: top.children, end, selfClosing: false };
      current().push(node);
      i = end;
    } else {
      const end = tagEnd(text, i);
      const source = text.slice(i, end);
      const name = /^<([^\s/>]+)/.exec(source)?.[1];
      if (!name) throw new XmlError(`Unexpected "<" (${position(text, i)})`);
      const tag: Tag = { name, start: i, end, source };
      if (source.endsWith("/>")) current().push({ type: "element", open: tag, children: [], end, selfClosing: true });
      else stack.push({ tag, children: [] });
      i = end;
    }
  }
  const unclosed = stack.pop();
  if (unclosed) throw new XmlError(`Unclosed <${unclosed.tag.name}> (${position(text, unclosed.tag.start)})`);
  return root;
}

/** The tag text; attributes that were spread over several lines are re-indented one level deeper. */
function openTag(tag: Tag, pad: string, indent: string): string {
  const source = tag.source;
  if (!source.includes("\n")) return source;
  // Rebuild from pieces: name, attributes (values untouched), closing bracket.
  const match = /^<([^\s/>]+)([\s\S]*?)(\/?>)$/.exec(source);
  if (!match) return source;
  const [, name, rest, close] = match;
  let out = "<" + name;
  const attribute = /(\s+)([^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)/gy;
  let last = 0;
  for (let m = attribute.exec(rest); m; m = attribute.exec(rest)) {
    out += (m[1].includes("\n") ? "\n" + pad + indent : " ") + m[2];
    last = attribute.lastIndex;
  }
  if (rest.slice(last).trim() !== "") return source; // unexpected shape: leave it alone
  const gap = rest.slice(last);
  if (gap.includes("\n")) out += "\n" + pad;
  else if (close === "/>" && /\s/.test(gap)) out += " ";
  return out + close;
}

const hasText = (children: Node[]) =>
  children.some((c) => (c.type === "text" && c.text.trim() !== "") || (c.type === "raw" && c.cdata));

export function formatXml(text: string, indent: string): FormatResult {
  let nodes: Node[];
  try {
    nodes = parse(text);
  } catch (e) {
    if (e instanceof XmlError) return { error: e.message };
    throw e;
  }
  const lines: string[] = [];
  const emit = (line: string, depth: number) => lines.push(indent.repeat(depth) + line);

  const walk = (children: Node[], depth: number) => {
    let newlines = 0; // newlines seen in whitespace since the previous node
    let first = true;
    for (const child of children) {
      if (child.type === "text") {
        if (child.text.trim() !== "") {
          emit(child.text.trim(), depth);
          first = false;
          newlines = 0;
        } else newlines += (child.text.match(/\n/g) ?? []).length;
        continue;
      }
      // Keep one blank line where the author grouped siblings.
      if (!first && newlines >= 2) lines.push("");
      newlines = 0;
      first = false;
      if (child.type === "raw") {
        emit(child.text, depth);
        continue;
      }
      element(child, depth);
    }
  };

  const element = (node: Extract<Node, { type: "element" }>, depth: number) => {
    const pad = indent.repeat(depth);
    const tag = openTag(node.open, pad, indent);
    if (node.selfClosing) return emit(tag, depth);
    const verbatim = () => emit(text.slice(node.open.start, node.end), depth);
    if (/\sxml:space\s*=\s*["']preserve["']/.test(node.open.source) || hasText(node.children)) return verbatim();
    const content = node.children.filter((c) => !(c.type === "text" && c.text.trim() === ""));
    const close = `</${node.open.name}>`;
    if (content.length === 0) {
      // Whitespace-only content is formatting unless it is a lone space on one line.
      const space = node.children.map((c) => (c.type === "text" ? c.text : "")).join("");
      return space !== "" && !space.includes("\n") ? verbatim() : emit(tag + close, depth);
    }
    emit(tag, depth);
    walk(node.children, depth + 1);
    emit(close, depth);
  };

  walk(nodes, 0);
  return { text: lines.join("\n") };
}
