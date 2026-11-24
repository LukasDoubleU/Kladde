// Does pasted text look like Markdown? Used once, for the first paste into an empty untitled tab
// (workspace.svelte.ts, `maybeSwitchToMarkdown`); a wrong guess costs one click ("Keep Plain Text"), so the
// detector is conservative: it needs clear evidence and backs off from anything that looks like code or data.
//
// Pure and dependency-free (unit-tested in tests/unit/markdown-detect.test.mjs). Only a bounded prefix is read
// (SNIFF_CHARS, MAX_LINES), so a huge paste costs the same as a small one.
//
// Rules
//
// 1. Hard rejects (the text is something else, whatever else it contains): a shebang line; JSON (starts with `{`
//    or `[` and parses, or is an object with `"key":` lines); XML and HTML (a prolog or doctype, `<html`, or half of
//    the lines start with `<`); a diff (`diff --git`, `@@ -1,2 +1,2 @@`, `--- a/…`); a stack trace; log output
//    (timestamps or levels at the start of 30 % of the lines); code and data, measured on the lines outside fenced
//    blocks and headings: 25 % end in `;` `{` `}`, 30 % are statements (import, def, echo, git, SELECT, Dockerfile
//    instructions, `name = value`, calls), 40 % are `key: value` (YAML) or `key = value` (INI, .env), or rows of a CSV.
// 2. Points, summed; the text is Markdown from 3 points. A single weak signal is never enough.
//    - closed fenced block (``` or ~~~): 3 (unclosed: 2)
//    - GFM table (a header row with `|` and a `|---|` separator): 3
//    - ATX heading `# x` (up to three spaces of indent) that is followed by content, i.e. a list, a fenced block, a
//      table, a quote or a sentence (3 words, no code): 3 for the first, 1 for each further one (at most 4). A heading
//      with nothing after it counts 1 (at most 2 together): `# comment` lines of shell, Python, YAML or TOML must
//      not add up. A `#` line whose next line is a statement is a comment and counts nothing.
//    - front matter at the start (`---` … `---`): 1, and its lines are ignored by everything else
//    - setext heading: `Title` over `=====` counts like an ATX heading (3 with content after it, else 1); over `-----` 1
//    - links `[text](target)` 1.5 each and images `![alt](target)` 2 each, at most 3 together; a reference
//      definition `[id]: target`: 1
//    - task list item `- [ ]` / `- [x]`: 2
//    - list (two or more items of `-` `*` `+` `1.` `1)`): 1. A plain list alone (even of ten items) stays plain text
//      on purpose: it is as valid as plain text, and a notes tab with "- milk", "- eggs" should not change.
//    - emphasis `**bold**` (also `__two words__`): 1, two or more: 2. Italics are not counted (`*.txt`, `snake_case`).
//    - `inline code`: 1 for two or more spans
//    - blockquote `> text`: 0.5, two or more lines: 1.5 (plain-text email replies quote that way too)
//
// Lines inside fenced blocks count for nothing but the fence itself, so a README with a shell or Python example
// is Markdown, while a Python file with `#` comments is not.

/** How much of a paste is looked at (UTF-16 code units). Callers cut their slice at SNIFF_CHARS + 1 to let the detector see a cut. */
export const SNIFF_CHARS = 64 * 1024;
const MAX_LINES = 400;
const THRESHOLD = 3;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_SEPARATOR = /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;
const LIST_ITEM = /^ {0,8}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const TASK_ITEM = /^ {0,8}[-*+][ \t]+\[[ xX]\][ \t]+\S/;
const QUOTE = /^ {0,3}>[ \t]*\S/;
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/;
const LINK = /(?<![\w\]!])\[[^\]\n]+\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/g;
const REFERENCE_LINK = /(?<![\w\]!])\[[^\]\n]+\]\[[\w -]*\]/g;
const IMAGE = /!\[[^\]\n]*\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/g;
const BOLD = /(?<![\w*])\*\*(?=\S)[^*\n]+?(?<=\S)\*\*(?![\w*])/g;
const BOLD_UNDERSCORE = /(?<![\w])__(?=\S)[^_\n]*\s[^_\n]*(?<=\S)__(?![\w])/g;
const INLINE_CODE = /`[^`\n]+`/g;

// A statement of a programming, shell, SQL or build language. Words that are also English start only in the
// shapes code gives them.
const STATEMENT = new RegExp(
  "^\\s*(?:" +
    [
      "import\\s+[\\w.{*]",
      "from\\s+[\\w.]+\\s+import\\b",
      "def\\s+\\w+\\s*\\(",
      "class\\s+\\w+\\s*[(:{]",
      "function\\s*\\w*\\s*\\(",
      "(?:const|let|var)\\s+\\w+\\s*[=:;]",
      "return\\b[^.!?]*[;)\\]]\\s*$",
      "print\\(",
      "echo\\s",
      "export\\s+\\w+=",
      "sudo\\s",
      "apt(?:-get)?\\s+install",
      "npm\\s+(?:i|install|run|ci|test|start)\\b",
      "pip3?\\s+install",
      "git\\s+(?:clone|add|commit|push|pull|checkout|status|init|fetch|merge|rebase)\\b",
      "cd\\s+\\S",
      "#include\\b",
      "using\\s+[\\w.]+;",
      "namespace\\s+[\\w.]+",
      "(?:public|private|protected|internal)\\s+(?:static\\s+)?[\\w<>\\[\\]]+\\s+\\w+",
      "(?:SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE|ALTER\\s+TABLE|DROP\\s+TABLE)\\b",
      "(?:FROM|RUN|COPY|ADD|CMD|ENTRYPOINT|ENV|ARG|WORKDIR|EXPOSE)\\s",
      "@echo\\b",
      "\\$\\s+\\S",
      "(?:else|try|finally):\\s*$",
      "for\\s+\\w+\\s+in\\s+.+:\\s*$",
      "(?:if|elif|while)\\s+.*(?:==|!=|<=|>=|\\(|\\bnot\\b).*:\\s*$",
      "except\\b.*:\\s*$",
    ].join("|") +
    ")",
);
const ASSIGNMENT = /^\s*[A-Za-z_][\w.[\]-]*\s*[:+\-*/]?=\s*\S/;
const CALL = /^\s*[\w.]+\([^)]*\)\s*;?\s*$/;
const KEY_VALUE = /^\s*[\w.-]+:(?:[ \t]+\S.*)?$/;

const LOG_LINE =
  /^\s*\[?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|\d{1,2}\/\w{3}\/\d{4})|^\s*\[?(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\]?[\s:]/;
const TRACE_LINE = /^\s+at\s+[\w$.<>]+\(.*\)|^Traceback \(most recent|^\s+File ".*", line \d+/;
const DIFF_LINE = /^diff --git |^@@ -\d+(?:,\d+)? \+\d+|^(?:---|\+\+\+) [ab]\//;

function isCodeLike(line: string): boolean {
  return STATEMENT.test(line) || ASSIGNMENT.test(line) || CALL.test(line);
}

/** A sentence-like line: at least three words, no code symbols, not a statement. */
function isProse(line: string): boolean {
  const t = line.trim();
  return t.split(/\s+/).length >= 3 && !/[{};=<>|\\$]/.test(t) && !isCodeLike(t) && !HEADING.test(line) && !/^[-=]{3,}$/.test(t) && !/^\.\. |^:\w+:/.test(t);
}

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

function looksLikeJsonOrMarkup(text: string, lines: string[], complete: boolean): boolean {
  const first = text.trimStart();
  if (first.startsWith("{") || first.startsWith("[")) {
    const nonBlank = lines.filter((l) => l.trim() !== "");
    if (nonBlank[0].trim() === "{" || nonBlank[0].trim() === "[") return true;
    if (nonBlank[1] !== undefined && /^\s*"[^"\n]*"\s*:/.test(nonBlank[1])) return true;
    if (complete) {
      try {
        JSON.parse(text);
        return true;
      } catch {
        /* not JSON: `[a link](x)` and friends */
      }
    }
  }
  if (first.startsWith("<")) {
    if (/^<(?:\?xml|!doctype|html|head|body)/i.test(first)) return true;
    const nonBlank = lines.filter((l) => l.trim() !== "");
    if (nonBlank.filter((l) => l.trimStart().startsWith("<")).length * 2 >= nonBlank.length) return true;
  }
  return false;
}

export function looksLikeMarkdown(text: string): boolean {
  const head = text.length > SNIFF_CHARS ? text.slice(0, SNIFF_CHARS) : text;
  const cut = head.length < text.length;
  let lines = head.split(/\r?\n/);
  if (cut) lines.pop(); // the last line is probably cut in the middle
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
  }
  const complete = !cut && lines.length === head.split(/\r?\n/).length;
  if (!lines.some((l) => l.trim() !== "")) return false;
  // Front matter (`---`, YAML, `---`) is blanked out before the other rules look at the text, and counts as a weak signal.
  let frontMatter = false;
  if (/^---\s*$/.test(lines[0])) {
    const end = lines.findIndex((l, i) => i > 0 && i <= 100 && /^(?:---|\.\.\.)\s*$/.test(l));
    if (end > 0) {
      frontMatter = true;
      lines = lines.map((l, i) => (i <= end ? "" : l));
    }
  }
  if (!lines.some((l) => l.trim() !== "")) return false;
  const firstLine = lines.find((l) => l.trim() !== "")!;
  if (firstLine.startsWith("#!")) return false;
  if (looksLikeJsonOrMarkup(lines.join("\n"), lines, complete)) return false;

  // Classify the lines: inside a fenced block or not, and the fence itself.
  const inFence: boolean[] = [];
  let closedFences = 0;
  let openFence = false;
  let fence: { char: string; length: number } | null = null;
  const fenceStart: boolean[] = [];
  for (const line of lines) {
    if (fence) {
      inFence.push(true);
      fenceStart.push(false);
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
        closedFences++;
      }
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      inFence.push(true);
      fenceStart.push(true);
    } else {
      inFence.push(false);
      fenceStart.push(false);
    }
  }
  if (fence) openFence = true;

  // The lines that are text of the document itself: the base of every ratio and of the point signals.
  const prose: string[] = [];
  const indexes: number[] = [];
  lines.forEach((line, i) => {
    if (!inFence[i] && line.trim() !== "") {
      prose.push(line);
      indexes.push(i);
    }
  });

  // Diffs, traces and logs.
  let logs = 0;
  let traces = 0;
  for (const line of prose) {
    if (DIFF_LINE.test(line)) return false;
    if (TRACE_LINE.test(line)) traces++;
    if (LOG_LINE.test(line)) logs++;
  }
  if (traces >= 2) return false;
  if (logs >= 3 && logs * 10 >= prose.length * 3) return false;

  // Code and data ratios, on the lines that are not headings (a `#` line is a heading or a comment: decided below).
  const body = prose.filter((l) => !HEADING.test(l));
  if (body.length >= 2) {
    const ratio = (test: (l: string) => boolean) => body.filter(test).length / body.length;
    if (ratio((l) => /[;{}]\s*$/.test(l)) >= 0.25) return false;
    if (ratio(isCodeLike) >= 0.3) return false;
    // Three lines at least: two `Date: Monday` lines in a page of notes are not a YAML file.
    const many = (test: (l: string) => boolean) => body.filter(test).length >= 3 && ratio(test) >= 0.4;
    if (many((l) => KEY_VALUE.test(l)) || many((l) => ASSIGNMENT.test(l))) return false;
    if (body.length >= 3) {
      const commas = body.slice(0, 10).map((l) => count(/,/g, l));
      if (commas[0] >= 2 && commas.filter((c) => c === commas[0]).length * 5 >= commas.length * 4) return false;
    }
  }

  let score = frontMatter ? 1 : 0;
  if (closedFences > 0) score += 3;
  else if (openFence) score += 2;

  // Headings, table, setext headings.
  let supported = 0;
  let unsupported = 0;
  let table = false;
  let setext = 0;
  for (let n = 0; n < indexes.length; n++) {
    const i = indexes[n];
    const line = lines[i];
    const next = lines.slice(i + 1).findIndex((l) => l.trim() !== "");
    const nextIndex = next < 0 ? -1 : i + 1 + next;
    const nextLine = nextIndex < 0 ? "" : lines[nextIndex];
    const heading = line.match(HEADING);
    if (heading) {
      if (isCodeLike(heading[2])) continue;
      if (nextIndex >= 0 && !fenceStart[nextIndex] && isCodeLike(nextLine)) continue; // a comment above a statement
      const support =
        nextIndex >= 0 &&
        (fenceStart[nextIndex] || LIST_ITEM.test(nextLine) || QUOTE.test(nextLine) || (nextLine.includes("|") && !inFence[nextIndex]) || isProse(nextLine));
      if (support) supported++;
      else unsupported++;
      continue;
    }
    if (!table && line.includes("|") && i + 1 < lines.length && !inFence[i + 1] && lines[i + 1].includes("|") && TABLE_SEPARATOR.test(lines[i + 1])) {
      table = true;
    }
    // A text line over `=====` or `-----`, after a blank line: not YAML (`key: value`), not code, not a list item.
    const under = lines[i + 1];
    if (
      under !== undefined &&
      !inFence[i + 1] &&
      (i === 0 || lines[i - 1].trim() === "") &&
      !LIST_ITEM.test(line) &&
      !KEY_VALUE.test(line) &&
      !isCodeLike(line) &&
      !QUOTE.test(line)
    ) {
      if (/^ {0,3}={3,}[ \t]*$/.test(under)) {
        // Like an ATX heading: worth more when content follows. reStructuredText titles look the same, but come
        // with directives and field lists, which the ratios above mostly catch.
        const after = lines.slice(i + 2).findIndex((l) => l.trim() !== "");
        const afterLine = after < 0 ? "" : lines[i + 2 + after];
        if (after >= 0 && (fenceStart[i + 2 + after] || LIST_ITEM.test(afterLine) || isProse(afterLine))) supported++;
        else unsupported++;
      } else if (/^ {0,3}-{3,}[ \t]*$/.test(under)) setext += 1;
    }
  }
  if (table) score += 3;
  if (supported > 0) score += Math.min(4, 3 + (supported - 1));
  score += Math.min(2, unsupported);
  score += Math.min(3, setext);

  // Inline signals and lists, on the text outside fences.
  const joined = prose.join("\n");
  const images = count(IMAGE, joined);
  const links = count(LINK, joined) + count(REFERENCE_LINK, joined);
  score += Math.min(3, links * 1.5 + images * 2);
  if (prose.some((l) => REFERENCE.test(l))) score += 1;
  if (prose.some((l) => TASK_ITEM.test(l))) score += 2;
  if (prose.filter((l) => LIST_ITEM.test(l)).length >= 2) score += 1;
  const bold = count(BOLD, joined) + count(BOLD_UNDERSCORE, joined);
  score += bold >= 2 ? 2 : bold;
  if (count(INLINE_CODE, joined) >= 2) score += 1;
  const quotes = prose.filter((l) => QUOTE.test(l)).length;
  score += quotes >= 2 ? 1.5 : quotes === 1 ? 0.5 : 0;

  return score >= THRESHOLD;
}
