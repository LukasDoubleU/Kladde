// Text side of grammar checking: what to send to LanguageTool and how to map its answer back onto the
// document. Pure functions without DOM or Tauri, so Node can unit-test them (tests/unit/grammar.test.mjs).
//
// LanguageTool takes "annotated text": a list of text and markup pieces. Markup is not checked and
// `interpretAs` tells it what to read instead. Offsets in the answer count the markup too, so they are
// plain offsets into the text we sent, which is the document text, and map back without any shifting.

/** A part of the document that is not prose. `as` is what LanguageTool reads in its place. */
export interface Markup {
  from: number;
  to: number;
  as: string;
  /** Covers whole lines (code block, front matter, table rule): ends the paragraph. */
  block?: boolean;
  /** `as` is a stand-in word (code, link): grammar findings right next to it are unreliable. */
  word?: boolean;
}

/** A paragraph of the document, checked and cached as one unit. */
export interface Chunk {
  from: number;
  to: number;
}

export interface LtMatch {
  offset: number;
  length: number;
  message: string;
  shortMessage?: string;
  replacements?: { value: string }[];
  rule: { id: string; issueType?: string; category?: { id: string } };
}

export type FindingKind = "spelling" | "grammar" | "style";

export interface Finding {
  from: number;
  to: number;
  kind: FindingKind;
  message: string;
  rule: string;
  replacements: string[];
}

export interface Piece {
  chunk: Chunk;
  /** Offset of the chunk within the request text. */
  start: number;
}

export interface Request {
  /** The `data` form field: LanguageTool's annotated text as JSON. */
  data: string;
  pieces: Piece[];
}

// ------------------------------------------------------------------ markup

const isSentenceStart = (text: string, at: number): boolean => {
  let i = at - 1;
  while (i >= 0 && /[ \t*_~"“„«'(\[]/.test(text[i])) i--;
  return i < 0 || text[i] === "\n" || ".!?".includes(text[i]);
};

const standIn = (text: string, from: number, word: string): string =>
  isSentenceStart(text, from) ? word[0].toUpperCase() + word.slice(1) : word;

interface Inline {
  re: RegExp;
  /** The stand-in word, or "" for plain markup. */
  word: string;
  trim?: boolean;
}

// Order does not matter: overlaps are resolved by position, earlier and longer first.
const INLINE: Inline[] = [
  { re: /(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, word: "code" },
  { re: /\$\$[^\n]*?\$\$|(?<![\\$\w])\$(?:[^\s$\\]|[^\s$][^$\n]*?[^\s$\\])\$(?![\d$\w])/g, word: "formula" },
  { re: /<(?:https?:\/\/|mailto:)[^>\s]+>/g, word: "link" },
  { re: /\b(?:https?:\/\/|www\.)[^\s<>()[\]"']+/g, word: "link", trim: true },
  { re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, word: "email" },
  { re: /\]\((?:[^()\n]|\([^()\n]*\))*\)/g, word: "" },
  { re: /\]\[[^\]\n]*\]/g, word: "" },
  { re: /!?\[(?=[^\]\n]*\](?:\(|\[))/g, word: "" },
  { re: /\[\^[^\]\n]+\]/g, word: "" },
  { re: /<!--.*?-->/g, word: "" },
  { re: /<\/?[A-Za-z][^<>\n]*>/g, word: "" },
  { re: /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, word: "" },
  { re: /(?<!\s)\*{1,3}|\*{1,3}(?!\s)|~~/g, word: "" },
  { re: /(?<![\p{L}\p{N}_])_{1,3}(?=[^\s_])|(?<=[^\s_])_{1,3}(?![\p{L}\p{N}_])/gu, word: "" },
];

/** Inline markup of the line range [a, b): code, links, tags, emphasis, math, URLs. */
function inlineMarkup(text: string, a: number, b: number, urlsOnly: boolean, out: Markup[]) {
  const segment = text.slice(a, b);
  const found: Markup[] = [];
  for (const { re, word, trim } of INLINE) {
    if (urlsOnly && !(word === "link" || word === "email")) continue;
    re.lastIndex = 0;
    for (let m = re.exec(segment); m; m = re.exec(segment)) {
      let len = m[0].length;
      if (trim) while (len > 1 && ".,;:!?".includes(m[0][len - 1])) len--;
      const from = a + m.index;
      found.push(word ? { from, to: from + len, as: standIn(text, from, word), word: true } : { from, to: from + len, as: "" });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  found.sort((x, y) => x.from - y.from || y.to - x.to);
  let end = a;
  for (const m of found) {
    if (m.from < end) continue;
    out.push(m);
    end = m.to;
  }
}

const THEMATIC = /^ {0,3}(?:([-*_])(?: *\1){2,}|=+|-+) *$/;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/;
const QUOTE = /^(?: {0,3}>[ \t]?)+/;
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The parts of the text LanguageTool must not check. Markdown: front matter, code blocks, math, tables'
 * rules, list and heading markers, link targets, inline code, HTML, emphasis marks. Other text: URLs and
 * e-mail addresses only. The result is sorted and free of overlaps.
 */
export function markupFor(text: string, markdown: boolean): Markup[] {
  const out: Markup[] = [];
  if (!markdown) {
    inlineMarkup(text, 0, text.length, true, out);
    return out;
  }
  let pos = 0;
  const frontMatter = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (frontMatter) {
    const length = frontMatter[0].length;
    out.push({ from: 0, to: text[length - 1] === "\n" ? length - 1 : length, as: "\n\n", block: true });
    pos = length;
  }
  let fence: { char: string; length: number; from: number } | null = null;
  let mathFrom = -1;
  while (pos <= text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        out.push({ from: fence.from, to: end, as: "\n\n", block: true });
        fence = null;
      }
    } else if (mathFrom >= 0) {
      if (line.includes("$$")) {
        out.push({ from: mathFrom, to: end, as: "\n\n", block: true });
        mathFrom = -1;
      }
    } else if (line.trim() !== "") {
      const open = FENCE.exec(line);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = { char: open[1][0], length: open[1].length, from: pos };
      } else if (/^\s*\$\$/.test(line) && !/^\s*\$\$.*\$\$/.test(line)) {
        mathFrom = pos;
      } else if (THEMATIC.test(line) || (line.includes("|") && line.includes("-") && TABLE_RULE.test(line)) || REFERENCE_DEFINITION.test(line)) {
        out.push({ from: pos, to: end, as: "\n\n", block: true });
      } else {
        let col = pos;
        const quote = QUOTE.exec(line);
        if (quote) {
          out.push({ from: col, to: col + quote[0].length, as: "\n\n" });
          col += quote[0].length;
        }
        const rest = text.slice(col, end);
        const list = LIST.exec(rest);
        const heading = list ? null : HEADING.exec(rest);
        const marker = list ?? heading;
        if (marker) {
          out.push({ from: col, to: col + marker[0].length, as: "\n\n" });
          col += marker[0].length;
        }
        let stop = end;
        const close = heading ? HEADING_CLOSE.exec(text.slice(col, end)) : null;
        if (close) {
          out.push({ from: col + close.index, to: end, as: "" });
          stop = col + close.index;
        }
        if (text.slice(col, stop).trimStart().startsWith("|")) {
          // A table row: the pipes separate paragraphs, the cells are checked on their own. Padding next
          // to a pipe belongs to the separator, or aligned tables would be flagged for their spaces.
          let from = col;
          for (let i = col; i <= stop; i++) {
            if (i < stop && !(text[i] === "|" && text[i - 1] !== "\\")) continue;
            let before = i;
            let after = Math.min(i + 1, stop);
            if (i < stop) {
              while (before > from && /[ \t]/.test(text[before - 1])) before--;
              while (after < stop && /[ \t]/.test(text[after])) after++;
            }
            if (before > from) inlineMarkup(text, from, before, false, out);
            if (i < stop) out.push({ from: before, to: after, as: "\n\n" });
            from = after;
            i = Math.max(i, after - 1);
          }
        } else {
          inlineMarkup(text, col, stop, false, out);
        }
      }
    }
    if (end >= text.length) break;
    pos = end + 1;
  }
  if (fence) out.push({ from: fence.from, to: text.length, as: "\n\n", block: true });
  if (mathFrom >= 0) out.push({ from: mathFrom, to: text.length, as: "\n\n", block: true });
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  const result: Markup[] = [];
  let covered = 0;
  for (const m of out) {
    if (m.from < covered) continue;
    result.push(m);
    covered = m.to;
  }
  return result;
}

// ------------------------------------------------------------------ chunks

/** Index of the first markup that ends after `pos`. */
function firstMarkupAfter(markup: Markup[], pos: number): number {
  let lo = 0;
  let hi = markup.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (markup[mid].to <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hasProse(text: string, markup: Markup[], chunk: Chunk): boolean {
  let p = chunk.from;
  for (let i = firstMarkupAfter(markup, chunk.from); i < markup.length && markup[i].from < chunk.to; i++) {
    if (markup[i].from > p && /\p{L}/u.test(text.slice(p, markup[i].from))) return true;
    p = Math.max(p, markup[i].to);
  }
  return p < chunk.to && /\p{L}/u.test(text.slice(p, chunk.to));
}

/**
 * The paragraphs overlapping [from, to]: runs of lines without blank lines or block markup between
 * them. Paragraphs longer than `maxLen` are cut at line ends or spaces, never inside markup.
 */
export function paragraphChunks(text: string, markup: Markup[], from: number, to: number, maxLen: number): Chunk[] {
  const blocks = markup.filter((m) => m.block);
  const chunks: Chunk[] = [];
  const push = (a: number, b: number) => {
    while (b - a > maxLen) {
      let cut = text.lastIndexOf("\n", a + maxLen);
      if (cut <= a) cut = text.lastIndexOf(" ", a + maxLen);
      if (cut <= a) cut = a + maxLen;
      for (let i = firstMarkupAfter(markup, a); i < markup.length && markup[i].from < cut; i++) {
        if (markup[i].to > cut) cut = markup[i].from > a ? markup[i].from : markup[i].to;
      }
      chunks.push({ from: a, to: cut });
      a = cut;
      while (a < b && /\s/.test(text[a])) a++;
    }
    if (b > a) chunks.push({ from: a, to: b });
  };
  let pos = from <= 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1;
  let start = -1;
  let last = -1;
  let b = 0;
  while (pos <= text.length && (pos <= to || start >= 0)) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    while (b < blocks.length && blocks[b].to < pos) b++;
    const inBlock = b < blocks.length && blocks[b].from <= pos;
    if (inBlock || text.slice(pos, end).trim() === "") {
      if (start >= 0) push(start, last);
      start = -1;
    } else {
      if (start < 0) start = pos;
      last = end;
    }
    if (end >= text.length) break;
    pos = end + 1;
  }
  if (start >= 0) push(start, last);
  return chunks.filter((c) => hasProse(text, markup, c));
}

// ------------------------------------------------------------------ request and answer

/** Annotated text for LanguageTool: the chunks one after the other, separated by blank lines. */
export function buildRequest(text: string, markup: Markup[], chunks: Chunk[]): Request {
  const items: { text?: string; markup?: string; interpretAs?: string }[] = [];
  const pieces: Piece[] = [];
  let length = 0;
  chunks.forEach((chunk, n) => {
    if (n > 0) {
      items.push({ text: "\n\n" });
      length += 2;
    }
    pieces.push({ chunk, start: length });
    let p = chunk.from;
    for (let i = firstMarkupAfter(markup, chunk.from); i < markup.length && markup[i].from < chunk.to; i++) {
      const from = Math.max(markup[i].from, chunk.from);
      const to = Math.min(markup[i].to, chunk.to);
      if (from > p) items.push({ text: text.slice(p, from) });
      items.push(markup[i].as ? { markup: text.slice(from, to), interpretAs: markup[i].as } : { markup: text.slice(from, to) });
      p = to;
    }
    if (p < chunk.to) items.push({ text: text.slice(p, chunk.to) });
    length += chunk.to - chunk.from;
  });
  return { data: JSON.stringify({ annotation: items }), pieces };
}

const STYLE_TYPES = new Set(["style", "typographical", "whitespace", "register", "locale-violation"]);
const STYLE_CATEGORIES = new Set(["STYLE", "TYPOGRAPHY", "REDUNDANCY", "PLAIN_ENGLISH", "WIKIPEDIA", "COLLOQUIALISMS"]);

export function kindOf(match: LtMatch): FindingKind {
  const category = match.rule.category?.id ?? "";
  if (category === "TYPOS" || /SPELL|MORFOLOGIK|HUNSPELL/i.test(match.rule.id)) return "spelling";
  if (STYLE_TYPES.has(match.rule.issueType ?? "") || STYLE_CATEGORIES.has(category)) return "style";
  return "grammar";
}

/** A match relative to its chunk, as cached. */
export function relativeMatches(request: Request, matches: LtMatch[]): LtMatch[][] {
  const result: LtMatch[][] = request.pieces.map(() => []);
  for (const match of matches) {
    const i = request.pieces.findIndex(
      (p) => match.offset >= p.start && match.offset + match.length <= p.start + p.chunk.to - p.chunk.from,
    );
    if (i >= 0) result[i].push({ ...match, offset: match.offset - request.pieces[i].start });
  }
  return result;
}

/**
 * Findings of a chunk's matches, in document positions. Matches that touch markup are dropped: the
 * replacement would eat it. Grammar and style findings directly next to a stand-in word (`code`, `link`)
 * are dropped too, since LanguageTool saw the stand-in and not the real text.
 */
export function findingsOf(chunk: Chunk, matches: LtMatch[], markup: Markup[]): Finding[] {
  const found: Finding[] = [];
  for (const match of matches) {
    const from = chunk.from + match.offset;
    const to = from + match.length;
    if (to > chunk.to) continue;
    const kind = kindOf(match);
    const reach = kind === "spelling" ? 0 : 1;
    let blocked = false;
    for (let i = firstMarkupAfter(markup, from - reach - 1); i < markup.length && markup[i].from <= to + reach; i++) {
      const m = markup[i];
      if (m.from < to && m.to > from) blocked = true;
      else if (m.word && m.from <= to + reach && m.to >= from - reach) blocked = true;
    }
    if (blocked) continue;
    found.push({
      from,
      to,
      kind,
      message: match.message,
      rule: match.rule.id,
      replacements: (match.replacements ?? []).slice(0, 6).map((r) => r.value),
    });
  }
  return found;
}

/** Matches by paragraph text and language, so unchanged paragraphs are not asked about twice. */
export class MatchCache {
  private map = new Map<string, LtMatch[]>();
  private max: number;

  constructor(max = 3000) {
    this.max = max;
  }

  static key(language: string, paragraph: string): string {
    return `${language}\u0000${paragraph}`;
  }

  get(key: string): LtMatch[] | undefined {
    return this.map.get(key);
  }

  set(key: string, matches: LtMatch[]) {
    this.map.delete(key);
    this.map.set(key, matches);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  clear() {
    this.map.clear();
  }
}

export interface WindowCheck {
  text: string;
  markup: Markup[];
  /** The part of the document to cover. */
  from: number;
  to: number;
  /** Where the reader is; paragraphs close to it are asked first. */
  focus: number;
  language: string;
  /** Most characters of text per request. */
  budget: number;
  cache: MatchCache;
  /** One request to the server. Failures are reported in the result, the cache keeps what it has. */
  check: (request: Request) => Promise<LtMatch[]>;
}

export interface WindowResult {
  findings: Finding[];
  /** Paragraphs of the window not checked yet (over the request budget, or the request failed). */
  remaining: number;
  error?: unknown;
}

/** Findings for a window of the document, asking the server only about paragraphs not seen before. */
export async function checkWindow(o: WindowCheck): Promise<WindowResult> {
  const chunks = paragraphChunks(o.text, o.markup, o.from, o.to, o.budget);
  const keyOf = (c: Chunk) => MatchCache.key(o.language, o.text.slice(c.from, c.to));
  const todo = chunks.filter((c) => !o.cache.get(keyOf(c)));
  let error: unknown;
  let remaining = 0;
  if (todo.length > 0) {
    todo.sort((a, b) => Math.abs((a.from + a.to) / 2 - o.focus) - Math.abs((b.from + b.to) / 2 - o.focus));
    const take: Chunk[] = [];
    let size = 0;
    for (const c of todo) {
      if (take.length > 0 && size + c.to - c.from + 2 > o.budget) continue;
      take.push(c);
      size += c.to - c.from + 2;
    }
    remaining = todo.length - take.length;
    take.sort((a, b) => a.from - b.from);
    const request = buildRequest(o.text, o.markup, take);
    try {
      const per = relativeMatches(request, await o.check(request));
      take.forEach((c, i) => o.cache.set(keyOf(c), per[i]));
    } catch (e) {
      error = e;
      remaining += take.length;
    }
  }
  const findings: Finding[] = [];
  for (const c of chunks) {
    const matches = o.cache.get(keyOf(c));
    if (matches) findings.push(...findingsOf(c, matches, o.markup));
  }
  return { findings, remaining, error };
}

// ------------------------------------------------------------------ language and server

export const LANGUAGES: { id: string; label: string }[] = [
  { id: "auto", label: "Detect automatically" },
  { id: "en-US", label: "English (US)" },
  { id: "en-GB", label: "English (UK)" },
  { id: "de-DE", label: "German (Germany)" },
  { id: "de-AT", label: "German (Austria)" },
  { id: "de-CH", label: "German (Switzerland)" },
  { id: "fr", label: "French" },
  { id: "es", label: "Spanish" },
  { id: "it", label: "Italian" },
  { id: "pt-PT", label: "Portuguese (Portugal)" },
  { id: "pt-BR", label: "Portuguese (Brazil)" },
  { id: "nl", label: "Dutch" },
  { id: "pl-PL", label: "Polish" },
  { id: "ru-RU", label: "Russian" },
  { id: "uk-UA", label: "Ukrainian" },
  { id: "sv", label: "Swedish" },
  { id: "da-DK", label: "Danish" },
  { id: "ca-ES", label: "Catalan" },
];

const DEFAULT_VARIANT: Record<string, string> = { en: "en-US", de: "de-DE", pt: "pt-PT", ca: "ca-ES", pl: "pl-PL", ru: "ru-RU", uk: "uk-UA", da: "da-DK" };

/** LanguageTool wants a variant for some languages: "en" becomes "en-US". Returns null for nonsense. */
export function normalizeLanguage(code: string): string | null {
  const c = code.trim();
  if (c.toLowerCase() === "auto") return "auto";
  const m = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z0-9]{2,8}))?$/.exec(c);
  if (!m) return null;
  const base = m[1].toLowerCase();
  return m[2] ? `${base}-${m[2].length === 2 ? m[2].toUpperCase() : m[2]}` : (DEFAULT_VARIANT[base] ?? base);
}

/** The `lang:` or `language:` key of a Markdown file's front matter. */
export function frontMatterLanguage(text: string): string | null {
  const block = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!block) return null;
  const m = /^(?:lang|language)[ \t]*:[ \t]*["']?([A-Za-z0-9_-]+)["']?[ \t]*$/im.exec(block[1]);
  return m ? normalizeLanguage(m[1]) : null;
}

/** The public LanguageTool API (and its subdomains): the one server that is a third party. */
export function isPublicServer(server: string): boolean {
  try {
    const host = new URL(server.trim()).hostname.toLowerCase();
    return /(^|\.)languagetool(plus)?\.(org|com)$/.test(host);
  } catch {
    return false;
  }
}
