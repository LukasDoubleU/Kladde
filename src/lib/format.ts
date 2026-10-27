// Pretty-printing. JSON is re-indented token by token instead of going through
// JSON.parse/stringify, so numbers (big integers, 1.0) and string escapes stay exactly as written.

/** Validates JSON and returns a readable error, or null if it is valid. */
function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const pos = /position (\d+)/.exec(message);
    if (!pos) return message;
    const before = text.slice(0, Number(pos[1]));
    const line = before.split("\n").length;
    const col = before.length - before.lastIndexOf("\n");
    return `${message.replace(/ in JSON at position \d+.*/, "")} (line ${line}, column ${col})`;
  }
}

/** Calls `emit` for every token outside strings, and for whole strings, skipping whitespace. */
function tokens(text: string, emit: (token: string) => void) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      emit(text.slice(i, j + 1));
      i = j + 1;
    } else if (/\s/.test(ch)) {
      i++;
    } else if ("{}[],:".includes(ch)) {
      emit(ch);
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s{}[\],:"]/.test(text[j])) j++;
      emit(text.slice(i, j));
      i = j;
    }
  }
}

export type FormatResult = { text: string } | { error: string };

export function formatJson(text: string, indent: string): FormatResult {
  const error = jsonError(text);
  if (error) return { error };
  let out = "";
  let depth = 0;
  let previous = "";
  const newline = () => "\n" + indent.repeat(depth);
  tokens(text, (token) => {
    if (token === "}" || token === "]") {
      depth--;
      // Keep empty objects and arrays on one line.
      out += previous === "{" || previous === "[" ? token : newline() + token;
    } else if (token === ",") {
      out += "," + newline();
    } else if (token === ":") {
      out += ": ";
    } else {
      if (previous === "{" || previous === "[") out += newline();
      out += token;
      if (token === "{" || token === "[") depth++;
    }
    previous = token;
  });
  return { text: out };
}

export function minifyJson(text: string): FormatResult {
  const error = jsonError(text);
  if (error) return { error };
  let out = "";
  tokens(text, (token) => (out += token));
  return { text: out };
}
