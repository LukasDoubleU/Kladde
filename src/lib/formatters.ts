// Picks a formatter from the tab's language. JSON uses the own formatter (in the main bundle), XML the
// own small one; Prettier (standalone, with only the plugins a language needs) and sql-formatter are
// third-party. All but JSON are imported on first use, so they cost nothing at startup.

import { formatJson, type FormatResult } from "./format.ts";

export type Formatter =
  | { kind: "json" }
  | { kind: "xml" }
  | { kind: "sql"; dialect: string }
  | { kind: "prettier"; parser: string };

export type FormatOptions = { tabSize: number; insertSpaces: boolean };

/** Kladde language names (see languages.ts) to formatters. */
const FORMATTERS: Record<string, Formatter> = {
  JSON: { kind: "json" },
  "JSON-LD": { kind: "json" },
  XML: { kind: "xml" },
  SQL: { kind: "sql", dialect: "sql" },
  MySQL: { kind: "sql", dialect: "mysql" },
  "MariaDB SQL": { kind: "sql", dialect: "mariadb" },
  PostgreSQL: { kind: "sql", dialect: "postgresql" },
  "MS SQL": { kind: "sql", dialect: "transactsql" },
  SQLite: { kind: "sql", dialect: "sqlite" },
  PLSQL: { kind: "sql", dialect: "plsql" },
  JavaScript: { kind: "prettier", parser: "babel" },
  JSX: { kind: "prettier", parser: "babel" },
  // babel-ts handles TSX too, so the large typescript plugin is not needed.
  TypeScript: { kind: "prettier", parser: "babel-ts" },
  TSX: { kind: "prettier", parser: "babel-ts" },
  CSS: { kind: "prettier", parser: "css" },
  SCSS: { kind: "prettier", parser: "scss" },
  LESS: { kind: "prettier", parser: "less" },
  HTML: { kind: "prettier", parser: "html" },
  Vue: { kind: "prettier", parser: "vue" },
  "Angular Template": { kind: "prettier", parser: "angular" },
  Markdown: { kind: "prettier", parser: "markdown" },
  YAML: { kind: "prettier", parser: "yaml" },
};

export function formatterFor(language: string | null): Formatter | null {
  return (language && FORMATTERS[language]) || null;
}

/** Names for the "unsupported language" notice. */
export function formattableLanguages(): string[] {
  return Object.keys(FORMATTERS);
}

/** Which Prettier plugins a parser needs. Embedded script and style in HTML and Vue need the JS and CSS ones. */
const PLUGINS: Record<string, string[]> = {
  babel: ["babel", "estree"],
  "babel-ts": ["babel", "estree"],
  css: ["postcss"],
  scss: ["postcss"],
  less: ["postcss"],
  html: ["html", "babel", "estree", "postcss"],
  vue: ["html", "babel", "estree", "postcss"],
  angular: ["html", "angular", "babel", "estree", "postcss"],
  markdown: ["markdown"],
  yaml: ["yaml"],
};

// Literal paths so the bundler splits each plugin into its own chunk.
const loadPlugin: Record<string, () => Promise<unknown>> = {
  babel: () => import("prettier/plugins/babel"),
  estree: () => import("prettier/plugins/estree"),
  postcss: () => import("prettier/plugins/postcss"),
  html: () => import("prettier/plugins/html"),
  angular: () => import("prettier/plugins/angular"),
  markdown: () => import("prettier/plugins/markdown"),
  yaml: () => import("prettier/plugins/yaml"),
};

async function formatPrettier(text: string, parser: string, options: FormatOptions): Promise<FormatResult> {
  const [{ format }, ...plugins] = await Promise.all([
    import("prettier/standalone"),
    ...PLUGINS[parser].map((name) => loadPlugin[name]()),
  ]);
  try {
    const out = await format(text, {
      parser,
      plugins: plugins as never,
      tabWidth: options.tabSize,
      useTabs: !options.insertSpaces,
    });
    return { text: out };
  } catch (e) {
    const err = e as { message?: string; loc?: { start?: { line: number; column: number } } };
    // The message continues with a code frame; the first line says what is wrong.
    let message = String(err.message ?? e).split("\n")[0];
    const start = err.loc?.start;
    if (start) message = `${message.replace(/\s*\(\d+:\d+\)$/, "")} (line ${start.line}, column ${start.column})`;
    return { error: message };
  }
}

async function formatSql(text: string, dialect: string, options: FormatOptions): Promise<FormatResult> {
  const { format } = await import("sql-formatter");
  try {
    return { text: format(text, { language: dialect as "sql", tabWidth: options.tabSize, useTabs: !options.insertSpaces }) };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e).split("\n")[0] };
  }
}

/**
 * Formats `text`. Line numbers in errors count from `firstLine`, for formatting a selection.
 * JSON stays on the own formatter, which keeps numbers and strings as written.
 */
export async function formatWith(
  formatter: Formatter,
  text: string,
  options: FormatOptions,
  firstLine = 1,
): Promise<FormatResult> {
  const indent = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
  let result: FormatResult;
  switch (formatter.kind) {
    case "json":
      result = formatJson(text, indent);
      break;
    case "xml":
      result = (await import("./format-xml.ts")).formatXml(text, indent);
      break;
    case "sql":
      result = await formatSql(text, formatter.dialect, options);
      break;
    case "prettier":
      result = await formatPrettier(text, formatter.parser, options);
      break;
  }
  if ("error" in result && firstLine > 1) {
    result = { error: result.error.replace(/\bline (\d+)/g, (_, n) => `line ${Number(n) + firstLine - 1}`) };
  }
  return result;
}

/**
 * Where `pos` of `before` lands in `after`, for text that differs only in layout: the same number of
 * non-whitespace characters precede it, then the original distance into the line's indentation.
 */
export function mapCursor(before: string, after: string, pos: number): number {
  const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  let count = 0;
  for (let i = 0; i < pos; i++) if (!isSpace(before[i])) count++;
  let j = 0;
  while (j < after.length && count > 0) if (!isSpace(after[j++])) count--;
  // Skip whitespace the cursor was behind: the newlines it followed, then its column in the indentation.
  let start = pos;
  while (start > 0 && isSpace(before[start - 1])) start--;
  const run = before.slice(start, pos);
  let newlines = (run.match(/\n/g) ?? []).length;
  let column = run.length - run.lastIndexOf("\n") - 1;
  while (newlines > 0 && j < after.length && isSpace(after[j])) if (after[j++] === "\n") newlines--;
  while (column > 0 && j < after.length && (after[j] === " " || after[j] === "\t")) {
    j++;
    column--;
  }
  return j;
}
