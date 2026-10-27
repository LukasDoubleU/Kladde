// Unit tests for the text side of grammar checking: markup masking, paragraphs, the request sent to
// LanguageTool and the mapping of its answer back to document positions.
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const load = (name) => import(pathToFileURL(resolve(import.meta.dirname, "../../src/lib", name)).href);
const {
  buildRequest,
  checkWindow,
  findingsOf,
  frontMatterLanguage,
  isPublicServer,
  kindOf,
  markupFor,
  MatchCache,
  normalizeLanguage,
  paragraphChunks,
  relativeMatches,
} = await load("grammar-text.ts");

/** The markup of a text as [covered text, read as] pairs. */
const masked = (text, markdown = true) => markupFor(text, markdown).map((m) => [text.slice(m.from, m.to), m.as]);
/** The text LanguageTool reads: markup replaced by what it should be read as. */
const read = (request) => JSON.parse(request.data).annotation.map((i) => i.text ?? i.interpretAs ?? "").join("");
/** The text of the request with markup kept, i.e. the document text at the same offsets. */
const raw = (request) => JSON.parse(request.data).annotation.map((i) => i.text ?? i.markup).join("");

const match = (offset, length, id = "RULE", issueType = "grammar", category = "GRAMMAR", replacements = ["x"]) => ({
  offset,
  length,
  message: "m",
  replacements: replacements.map((value) => ({ value })),
  rule: { id, issueType, category: { id: category } },
});

test("markup: inline code, links, emphasis and HTML are not prose", () => {
  const text = "Use `foo()` and **bold** with [a link](https://example.com/x) or <b>tags</b> here.";
  assert.deepEqual(masked(text), [
    ["`foo()`", "code"],
    ["**", ""],
    ["**", ""],
    ["[", ""],
    ["](https://example.com/x)", ""],
    ["<b>", ""],
    ["</b>", ""],
  ]);
});

test("markup: stand-in words are capitalized at the start of a sentence", () => {
  assert.deepEqual(masked("`a` is it. See `b`."), [
    ["`a`", "Code"],
    ["`b`", "code"],
  ]);
});

test("markup: fenced code, front matter and math blocks end paragraphs", () => {
  const text = "---\ntitle: x\n---\nIntro.\n\n```js\nlet a = 1;\n\nlet b = 2;\n```\nOutro.\n\n$$\nx = 1\n$$\n";
  const markup = markupFor(text, true);
  assert.deepEqual(
    markup.map((m) => [text.slice(m.from, m.to), !!m.block]),
    [
      ["---\ntitle: x\n---", true],
      ["```js\nlet a = 1;\n\nlet b = 2;\n```", true],
      ["$$\nx = 1\n$$", true],
    ],
  );
  const chunks = paragraphChunks(text, markup, 0, text.length, 1000);
  assert.deepEqual(chunks.map((c) => text.slice(c.from, c.to)), ["Intro.", "Outro."]);
});

test("markup: an unclosed fence runs to the end of the document", () => {
  const text = "Text.\n\n```\ncode\n\nmore code";
  assert.deepEqual(masked(text), [["```\ncode\n\nmore code", "\n\n"]]);
});

test("markup: list, quote and heading markers; tables are checked cell by cell", () => {
  const text = "# Title #\n\n- item one\n1. item two\n> quoted\n\n| a | b |\n|---|---|\n| c | d |\n";
  assert.deepEqual(masked(text).map(([t]) => t), ["# ", " #", "- ", "1. ", "> ", "| ", " | ", " |", "|---|---|", "| ", " | ", " |"]);
});

test("markup: URLs and addresses everywhere, but code only in Markdown", () => {
  const text = "See https://example.com/a?b=1. Mail me@example.org, `x`.";
  assert.deepEqual(masked(text, false), [
    ["https://example.com/a?b=1", "link"],
    ["me@example.org", "email"],
  ]);
});

test("markup: underscores inside words and prices are left alone", () => {
  assert.deepEqual(masked("snake_case and costs $5 and $6, _emphasis_."), [
    ["_", ""],
    ["_", ""],
  ]);
});

test("markup: inline math is masked, never overlaps and stays sorted", () => {
  const markup = markupFor("A $x^2$ b `c` [d](e) **f** <g>.", true);
  for (let i = 1; i < markup.length; i++) assert.ok(markup[i].from >= markup[i - 1].to);
});

test("chunks: paragraphs, windows, and long paragraphs cut at spaces outside markup", () => {
  const text = "First one.\n\nSecond one\nsecond line.\n\nThird.";
  const chunks = (from, to, max = 1000) => paragraphChunks(text, markupFor(text, false), from, to, max).map((c) => text.slice(c.from, c.to));
  assert.deepEqual(chunks(0, text.length), ["First one.", "Second one\nsecond line.", "Third."]);
  assert.deepEqual(chunks(14, 16), ["Second one\nsecond line."]);
  const long = "aaaa bbbb cccc dddd eeee ffff";
  assert.deepEqual(
    paragraphChunks(long, [], 0, long.length, 12).map((c) => long.slice(c.from, c.to)),
    ["aaaa bbbb", "cccc dddd", "eeee ffff"],
  );
  const code = "aaaa `bbbb cccc` dddd";
  const parts = paragraphChunks(code, markupFor(code, true), 0, code.length, 10).map((c) => code.slice(c.from, c.to));
  assert.ok(parts.every((p) => (p.match(/`/g) ?? []).length % 2 === 0), JSON.stringify(parts));
});

test("chunks: paragraphs without letters are not sent", () => {
  const text = "12 34\n\n`code only`\n\nReal words.";
  assert.deepEqual(
    paragraphChunks(text, markupFor(text, true), 0, text.length, 1000).map((c) => text.slice(c.from, c.to)),
    ["Real words."],
  );
});

test("request: the request text has the document's offsets, markup is read as its stand-in", () => {
  const text = "Fix `foo` now.\n\nA [link](http://x.y) here.";
  const markup = markupFor(text, true);
  const chunks = paragraphChunks(text, markup, 0, text.length, 1000);
  const request = buildRequest(text, markup, chunks);
  assert.equal(raw(request), "Fix `foo` now.\n\nA [link](http://x.y) here.");
  assert.equal(read(request), "Fix code now.\n\nA link here.");
  assert.deepEqual(request.pieces.map((p) => [p.chunk.from, p.start]), [[0, 0], [16, 16]]);

  // Only some paragraphs: offsets restart in the request, pieces tell where each one begins.
  const second = buildRequest(text, markup, [chunks[1]]);
  assert.equal(second.pieces[0].start, 0);
  assert.equal(raw(second), "A [link](http://x.y) here.");
});

test("answer: matches map back to the document, by paragraph", () => {
  const text = "One eror here.\n\nTwo erors there.";
  const markup = markupFor(text, true);
  const chunks = paragraphChunks(text, markup, 0, text.length, 1000);
  const request = buildRequest(text, markup, chunks);
  const per = relativeMatches(request, [match(4, 4), match(20, 5), match(14, 2)]);
  assert.deepEqual(per.map((m) => m.map((x) => x.offset)), [[4], [4]]);
  const found = findingsOf(chunks[1], per[1], markup);
  assert.equal(text.slice(found[0].from, found[0].to), "erors");
  assert.deepEqual(found[0].replacements, ["x"]);
});

test("answer: matches touching markup are dropped, grammar next to stand-ins too", () => {
  const text = "an `x` here and a eror.";
  const markup = markupFor(text, true);
  const chunk = { from: 0, to: text.length };
  const all = [
    match(0, 2, "A_AN"), // "an" next to `x`
    match(3, 3, "CODE", "grammar"), // the code itself
    match(16, 1, "A_AN"), // "a" before "eror": no markup near
    match(18, 4, "MORFOLOGIK_RULE_EN_US", "misspelling", "TYPOS"),
  ];
  const found = findingsOf(chunk, all, markup);
  assert.deepEqual(found.map((f) => text.slice(f.from, f.to)), ["a", "eror"]);
  assert.deepEqual(found.map((f) => f.kind), ["grammar", "spelling"]);
});

test("answer: findings are classified", () => {
  assert.equal(kindOf(match(0, 1, "MORFOLOGIK_RULE_DE_DE", "misspelling", "TYPOS")), "spelling");
  assert.equal(kindOf(match(0, 1, "WHITESPACE_RULE", "whitespace", "TYPOGRAPHY")), "style");
  assert.equal(kindOf(match(0, 1, "TOO_LONG", "style", "STYLE")), "style");
  assert.equal(kindOf(match(0, 1, "THIS_NNS", "grammar", "GRAMMAR")), "grammar");
  assert.equal(kindOf(match(0, 1, "EN_A_VS_AN", "misspelling", "MISC")), "grammar");
});

function windowOf(text, overrides = {}) {
  const calls = [];
  const options = {
    text,
    markup: markupFor(text, true),
    from: 0,
    to: text.length,
    focus: 0,
    language: "en-US",
    budget: 1000,
    cache: new MatchCache(),
    // Flags every "eror" in the text it gets.
    async check(request) {
      calls.push(read(request));
      const t = raw(request);
      return [...t.matchAll(/eror/g)].map((m) => match(m.index, 4, "SPELL", "misspelling", "TYPOS"));
    },
    ...overrides,
  };
  return { options, calls };
}

test("window: unchanged paragraphs come from the cache", async () => {
  const text = "A eror.\n\nFine text.\n\nAnother eror.";
  const { options, calls } = windowOf(text);
  const first = await checkWindow(options);
  assert.equal(calls.length, 1);
  assert.deepEqual(first.findings.map((f) => text.slice(f.from, f.to)), ["eror", "eror"]);
  assert.equal(first.remaining, 0);

  // An edit in the middle paragraph: only it is asked about again, positions move.
  const edited = "A eror.\n\nFine, indeed eror text.\n\nAnother eror.";
  const second = await checkWindow({ ...options, text: edited, markup: markupFor(edited, true), to: edited.length });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "Fine, indeed eror text.");
  assert.deepEqual(second.findings.map((f) => f.from), [2, 22, 42]);

  // Nothing changed: no request at all.
  await checkWindow({ ...options, text: edited, markup: markupFor(edited, true), to: edited.length });
  assert.equal(calls.length, 2);
});

test("window: the request budget limits the size, nearest paragraphs go first", async () => {
  const text = ["aaaa aaaa.", "bbbb bbbb.", "cccc cccc.", "dddd dddd."].join("\n\n");
  const { options, calls } = windowOf(text, { budget: 25, focus: text.length });
  const result = await checkWindow(options);
  assert.deepEqual(calls, ["cccc cccc.\n\ndddd dddd."]);
  assert.equal(result.remaining, 2);
  const next = await checkWindow({ ...options, focus: 0 });
  assert.deepEqual(calls.slice(1), ["aaaa aaaa.\n\nbbbb bbbb."]);
  assert.equal(next.remaining, 0);
});

test("window: a failing request keeps what the cache has and reports the error", async () => {
  const text = "A eror.\n\nSecond eror.";
  const { options } = windowOf(text);
  const warm = await checkWindow({ ...options, to: 7 });
  assert.equal(warm.findings.length, 1);
  const failing = await checkWindow({
    ...options,
    async check() {
      throw new Error("offline");
    },
  });
  assert.equal(failing.error.message, "offline");
  assert.equal(failing.remaining, 1);
  assert.equal(failing.findings.length, 1);
});

test("languages: codes are normalized, front matter and servers are recognized", () => {
  assert.equal(normalizeLanguage("en"), "en-US");
  assert.equal(normalizeLanguage("de_at"), "de-AT");
  assert.equal(normalizeLanguage("fr"), "fr");
  assert.equal(normalizeLanguage("AUTO"), "auto");
  assert.equal(normalizeLanguage("not a language"), null);
  assert.equal(frontMatterLanguage("---\ntitle: T\nlang: de\n---\nText"), "de-DE");
  assert.equal(frontMatterLanguage('---\nlanguage: "en-GB"\n---\n'), "en-GB");
  assert.equal(frontMatterLanguage("text\nlang: de\n"), null);
  assert.equal(isPublicServer("https://api.languagetool.org"), true);
  assert.equal(isPublicServer("https://api.languagetoolplus.com/v2"), true);
  assert.equal(isPublicServer("http://localhost:8081"), false);
  assert.equal(isPublicServer("https://languagetool.org.evil.example"), false);
});
