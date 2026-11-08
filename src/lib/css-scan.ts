// Scans CSS declaration values for references to other resources. Used by the document viewer to remove everything
// a document could make the WebView fetch (the generated CSS and style attributes are built from untrusted text).
// A small tokenizer, not a regular expression: CSS escapes (`u\72l(` is `url(`), comments and strings in between
// would get past a pattern. Plain TypeScript without imports, so unit tests can load it.

const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
const isIdentChar = (c: string) => /^[A-Za-z0-9_\-]$/.test(c) || c.charCodeAt(0) > 0x7f;
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** Reads one escape after a backslash at `i` (the backslash itself); returns the character and the next index. */
function readEscape(text: string, i: number): [string, number] {
  let j = i + 1;
  if (j >= text.length) return ["�", j];
  if (!isHex(text[j])) return [text[j], j + 1];
  let hex = "";
  while (j < text.length && hex.length < 6 && isHex(text[j])) hex += text[j++];
  if (j < text.length && isSpace(text[j])) j++;
  const code = parseInt(hex, 16);
  return [code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code), j];
}

/** Reads a quoted string starting at the quote; returns its value and the index after the closing quote. */
function readString(text: string, i: number): [string, number] {
  const quote = text[i];
  let j = i + 1;
  let value = "";
  while (j < text.length && text[j] !== quote) {
    if (text[j] === "\\") {
      if (text[j + 1] === "\n") {
        j += 2; // an escaped line break continues the string
        continue;
      }
      const [c, next] = readEscape(text, j);
      value += c;
      j = next;
    } else value += text[j++];
  }
  return [value, j + 1];
}

/** Reads the unquoted argument of `url(`, starting after the parenthesis. */
function readUrlToken(text: string, i: number): [string, number] {
  let j = i;
  while (j < text.length && isSpace(text[j])) j++;
  let value = "";
  while (j < text.length && text[j] !== ")") {
    if (text[j] === "\\") {
      const [c, next] = readEscape(text, j);
      value += c;
      j = next;
    } else value += text[j++];
  }
  return [value.trim(), j + 1];
}

/** `data:` is the only kind of address a document may use: the bytes are in the file itself. */
export function isDataUrl(value: string): boolean {
  // Only the start is looked at: a data: address can be megabytes long.
  return /^\s*data:/i.test(value.slice(0, 32));
}

// Functions that take an address (or a string that is one).
const URL_FUNCTIONS = new Set(["url", "src"]);
const IMAGE_SET_FUNCTIONS = new Set(["image-set", "-webkit-image-set"]);

/**
 * Whether a declaration value refers to anything but `data:` addresses: `url()` and `src()` with another address,
 * and every string inside `image-set()` that is not one (there strings are addresses). Escapes, comments and
 * strings are handled; a malformed value is judged by what the scan can read.
 */
export function referencesRemote(value: string): boolean {
  const text = value;
  let i = 0;
  // Parenthesis depths at which an image-set( was opened: strings inside are addresses.
  const imageSets: number[] = [];
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'") {
      const [s, next] = readString(text, i);
      if (imageSets.length > 0 && !isDataUrl(s)) return true;
      i = next;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      if (imageSets[imageSets.length - 1] === depth) imageSets.pop();
      depth = Math.max(0, depth - 1);
      i++;
    } else if (c === "\\" || isIdentChar(c)) {
      let name = "";
      while (i < text.length && (text[i] === "\\" || isIdentChar(text[i]))) {
        if (text[i] === "\\") {
          const [ch, next] = readEscape(text, i);
          name += ch;
          i = next;
        } else name += text[i++];
      }
      if (text[i] !== "(") continue;
      const lower = name.toLowerCase();
      if (URL_FUNCTIONS.has(lower)) {
        i++;
        let j = i;
        while (j < text.length && isSpace(text[j])) j++;
        let arg: string;
        let next: number;
        if (text[j] === '"' || text[j] === "'") {
          [arg, next] = readString(text, j);
          // Modifiers may follow the string (`url("a" x)`), up to the closing parenthesis.
          while (next < text.length && text[next] !== ")") next++;
          next++;
        } else [arg, next] = readUrlToken(text, i);
        if (!isDataUrl(arg)) return true;
        i = next;
      } else if (IMAGE_SET_FUNCTIONS.has(lower)) {
        i++;
        depth++;
        imageSets.push(depth);
      }
    } else i++;
  }
  return false;
}

/**
 * Splits the text of a declaration block (`CSSStyleDeclaration.cssText`) into its declarations, at the semicolons
 * outside strings, parentheses and comments. `name` is the property, `value` the rest without `!important`.
 */
export function splitDeclarations(cssText: string): { name: string; value: string }[] {
  const result: { name: string; value: string }[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  const push = (end: number) => {
    const part = cssText.slice(start, end);
    const colon = part.indexOf(":");
    if (colon > 0) result.push({ name: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() });
    start = end + 1;
  };
  while (i < cssText.length) {
    const c = cssText[i];
    if (c === "/" && cssText[i + 1] === "*") {
      const end = cssText.indexOf("*/", i + 2);
      i = end < 0 ? cssText.length : end + 2;
    } else if (c === '"' || c === "'") {
      i = readString(cssText, i)[1];
    } else if (c === "\\") {
      i = readEscape(cssText, i)[1];
    } else {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      else if (c === ";" && depth === 0) push(i);
      i++;
    }
  }
  if (start < cssText.length) push(cssText.length);
  return result;
}
