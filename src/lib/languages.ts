// Language detection: by extension, file name and shebang line.
//
// Uses the ~140 languages of @codemirror/language-data (each loaded on demand) plus
// small built-in highlighters for Windows batch files and log files.

import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { languages as bundled } from "@codemirror/language-data";
import { Tag, tags } from "@lezer/highlight";

export const logTags = {
  error: Tag.define(),
  warn: Tag.define(),
  info: Tag.define(),
  debug: Tag.define(),
  date: Tag.define(),
};

const BATCH_KEYWORDS = new Set(
  ("if else for in do goto call set echo exit setlocal endlocal not exist defined errorlevel equ neq lss leq gtr " +
    "geq shift pause cd chdir start pushd popd title cls copy move del erase mkdir md rmdir rd type ren rename " +
    "choice timeout where findstr find").split(" "),
);

const batch: StreamParser<{ lineStart: boolean }> = {
  name: "batch",
  startState: () => ({ lineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.lineStart = true;
    if (stream.eatSpace()) return null;
    const atStart = state.lineStart;
    state.lineStart = false;
    if (atStart && (stream.match(/^@?rem\b/i) || stream.match("::"))) {
      stream.skipToEnd();
      return "comment";
    }
    if (atStart && stream.match(/^:[^\s]+/)) return "labelName";
    if (stream.match(/^%~?[\w$]*%?|^![\w]+!/)) return "variableName";
    if (stream.match(/^"(?:[^"])*"?/)) return "string";
    if (stream.match(/^\d+\b/)) return "number";
    if (stream.eat("@")) {
      state.lineStart = true;
      return "meta";
    }
    if (stream.match(/^[<>|&()]+/)) return "operator";
    const word = stream.match(/^[\w.-]+/);
    if (word) return BATCH_KEYWORDS.has((word as RegExpMatchArray)[0].toLowerCase()) ? "keyword" : null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "REM" } },
};

const log: StreamParser<null> = {
  name: "log",
  startState: () => null,
  token(stream) {
    if (stream.sol() && stream.match(/^\s+at\s/)) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}([.,]\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?/)) return "logDate";
    if (stream.match(/^\d{2}:\d{2}:\d{2}([.,]\d+)?/)) return "logDate";
    if (stream.match(/^(ERROR|ERR|FATAL|CRITICAL|SEVERE|FAIL(ED|URE)?)\b/i)) return "logError";
    if (stream.match(/^(WARN(ING)?)\b/i)) return "logWarn";
    if (stream.match(/^(INFO|NOTICE)\b/i)) return "logInfo";
    if (stream.match(/^(DEBUG|TRACE|VERBOSE|FINE(R|ST)?)\b/i)) return "logDebug";
    if (stream.match(/^[\w$.]*(Exception|Error)\b/)) return "logError";
    if (stream.match(/^https?:\/\/\S+/)) return "url";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\b0x[\da-f]+\b|^\b\d+(\.\d+)?\b/i)) return "number";
    if (!stream.match(/^\w+/)) stream.next();
    return null;
  },
  tokenTable: {
    logDate: logTags.date,
    logError: logTags.error,
    logWarn: logTags.warn,
    logInfo: logTags.info,
    logDebug: logTags.debug,
    url: tags.url,
  },
};

const custom = [
  LanguageDescription.of({
    name: "Batch",
    extensions: ["bat", "cmd"],
    support: new LanguageSupport(StreamLanguage.define(batch)),
  }),
  LanguageDescription.of({
    name: "Log",
    extensions: ["log", "out", "err"],
    support: new LanguageSupport(StreamLanguage.define(log)),
  }),
];

export const allLanguages: readonly LanguageDescription[] = [...custom, ...bundled];

/** Extensions that language-data misses or maps unhelpfully. */
const EXTENSION_OVERRIDES: Record<string, string> = {
  cfg: "Properties files",
  conf: "Properties files",
  env: "Properties files",
  reg: "Properties files",
  editorconfig: "Properties files",
  gitconfig: "Properties files",
  npmrc: "Properties files",
  jsonc: "JSON",
  json5: "JSON",
  webmanifest: "JSON",
  har: "JSON",
  ipynb: "JSON",
  mdx: "Markdown",
  mdown: "Markdown",
  csproj: "XML",
  vbproj: "XML",
  fsproj: "XML",
  props: "XML",
  targets: "XML",
  xaml: "XML",
  resx: "XML",
  config: "XML",
  plist: "XML",
  wsdl: "XML",
  xslt: "XML",
  nuspec: "XML",
  manifest: "XML",
  pom: "XML",
  gitignore: "Shell",
  dockerignore: "Shell",
  zsh: "Shell",
  bashrc: "Shell",
  zshrc: "Shell",
  profile: "Shell",
  h: "C++",
};

const SHEBANGS: [RegExp, string][] = [
  [/\b(ba|z|k|da)?sh\b/, "Shell"],
  [/\bpython[\d.]*\b/, "Python"],
  [/\b(node|nodejs)\b/, "JavaScript"],
  [/\b(deno|bun|ts-node|tsx)\b/, "TypeScript"],
  [/\bpwsh\b|\bpowershell\b/, "PowerShell"],
  [/\bperl\b/, "Perl"],
  [/\bruby\b/, "Ruby"],
  [/\blua\b/, "Lua"],
  [/\bphp\b/, "PHP"],
];

export function findLanguage(name: string | null): LanguageDescription | null {
  if (!name) return null;
  return LanguageDescription.matchLanguageName(allLanguages, name, false);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function detectLanguage(path: string, firstLine: string): LanguageDescription | null {
  const name = fileName(path);
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower.replace(/^\./, "");

  if (lower === ".env" || lower.startsWith(".env.")) return findLanguage("Properties files");
  const override = EXTENSION_OVERRIDES[ext];
  if (override) return findLanguage(override);

  const byName = LanguageDescription.matchFilename(allLanguages, name);
  if (byName) return byName;

  if (firstLine.startsWith("#!")) {
    for (const [pattern, language] of SHEBANGS) if (pattern.test(firstLine)) return findLanguage(language);
  }
  const head = firstLine.trimStart().toLowerCase();
  if (head.startsWith("<?xml")) return findLanguage("XML");
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return findLanguage("HTML");
  return null;
}

export function languageNames(): string[] {
  return [...new Set(allLanguages.map((l) => l.name))].sort((a, b) => a.localeCompare(b));
}

export function isMarkdown(language: string | null): boolean {
  return language === "Markdown";
}

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "jfif", "apng"]);

export function extensionOf(path: string): string {
  const name = fileName(path).toLowerCase();
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}
