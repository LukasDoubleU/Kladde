// Unit tests for the Markdown detector of the first paste into an untitled tab, and for the extension that
// Save As suggests. TypeScript sources are imported directly (Node strips the types):
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const load = (name) => import(pathToFileURL(resolve(import.meta.dirname, "../../src/lib", name)).href);
const { looksLikeMarkdown, SNIFF_CHARS } = await load("markdown-detect.ts");
const { saveAsName } = await load("languages.ts");

const F = "```";

const POSITIVE = {
  "README with badge, install block and list": `# Kladde

![build](https://example.org/badge.svg)

A lightweight text editor.

## Install

${F}sh
npm ci
npm run build
${F}

## Features

- Tabs
- **Markdown** preview
- Hot exit
`,
  "chat answer with headings, numbered steps and code": `Sure! Here is how to do it.

## Steps

1. Open the **settings** page.
2. Set \`markdownPreview\` to \`split\`.
3. Restart the app.

${F}json
{ "markdownPreview": "split" }
${F}
`,
  "notes with only a heading and bullets": "# Shopping\n\n- milk\n- eggs\n- bread\n",
  "heading directly over a list": "## Today\n- call Anna\n- write report\n",
  "heading and one sentence": "# Meeting\n\nWe met on Monday and decided to move the release.\n",
  "heading without blank line before prose": "# Meeting\nWe met on Monday and decided to move the release.\n",
  "GFM table": "| Name | Size |\n|------|------|\n| a.txt | 12 |\n| b.txt | 40 |\n",
  "table with alignment and a sentence": "Results:\n\n| Name | Size |\n|:-----|-----:|\n| a | 1 |\n",
  "fenced block alone": `${F}js\nconsole.log("hi");\n${F}\n`,
  "tilde fence with prose": "Run this:\n\n~~~\nmake all\n~~~\n",
  "fenced Python example in prose": `Use it like this:\n\n${F}python\nimport os\nprint(os.getcwd())\n${F}\n\nThat prints the folder.\n`,
  "setext headings": "Release notes\n=============\n\nWhat changed in this version of the program.\n\nFixes\n-----\n\nA few small things were fixed.\n",
  "task list": "# Todo\n\n- [ ] write tests\n- [x] write code\n",
  "task list without heading": "- [ ] write tests\n- [x] write code\n",
  "links": "See [the docs](https://example.org/docs) and [the FAQ](https://example.org/faq).\n",
  "image and link": "![logo](assets/logo.png)\n\nSee [the docs](docs/index.md).\n",
  "numbered list with bold and inline code": "Options:\n\n1. **Option A**: fast, use `a`\n2. **Option B**: cheap, use `b`\n",
  "blockquote under a heading": "# Quote\n\n> To be or not to be\n> that is the question\n",
  "reference links": "Read [the guide][1] and [the spec][2] first.\n\n[1]: https://example.org/guide\n[2]: https://example.org/spec\n",
  "changelog": "## [1.0.0] - 2024-01-01\n\n### Added\n\n- Tabs\n- Search\n\n### Fixed\n\n- A crash\n",
  "CRLF README": "# Title\r\n\r\nSome text with a [link](https://example.org).\r\n\r\n- one\r\n- two\r\n",
  "README that starts with inline HTML": '<p align="center"><img src="logo.png" width="100"></p>\n\n# Project\n\nA tool for people who write a lot.\n',
  "German notes with umlauts": "# Einkaufsliste\n\nWir brauchen noch Äpfel und Brötchen für das Frühstück.\n\n- Äpfel\n- Brötchen\n",
  "Markdown with a table and a diff-like fence": `# Changes\n\n${F}diff\n- old\n+ new\n${F}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`,
  "bold labels in a list (chat answer)": "Here are three tips:\n\n- **Sleep**: get 8 hours\n- **Water**: drink more\n- **Move**: walk daily",
  "front matter, heading and text": "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Hello\n\nSome intro text for the post.\n",
  "notes with key: value lines and a section": "Meeting notes\n\nAttendees: Anna, Bob\nDate: Monday\n\n## Decisions\n\n- ship friday\n",
  "# Title with code fence containing comments": `# Setup\n\n${F}sh\n# install\nnpm ci\n${F}\n`,
};

const NEGATIVE = {
  "prose email": "Hi Anna,\n\nthanks for the quick answer. I will send the report on Monday.\n\nBest regards,\nBob\n",
  "one sentence": "Remember to call the dentist tomorrow morning.",
  "bulleted plain list of three items (on purpose)": "- milk\n- eggs\n- bread\n",
  "numbered plain list": "1. milk\n2. eggs\n3. bread\n",
  "a single heading line": "# Title\n",
  "one link only": "See [the docs](https://example.org/docs) for details.\n",
  "email reply with quotes and a short list": "Hi,\n\n> Can we meet?\n> On Tuesday?\n\nSure:\n- 10:00\n- 14:00\n",
  "Python script with # comments": `# Utilities for parsing\n\nimport os\n\n# Paths\nBASE = os.getcwd()\n\ndef parse(path, **kwargs):\n    # Read the file\n    with open(path) as f:\n        return f.read()\n\n## Main\nif __name__ == "__main__":\n    print(parse("a.txt"))\n`,
  "Python with dunder methods and a comment heading": "# Model\n\nclass Model:\n    def __init__(self, __x__):\n        self.x = __x__\n",
  "bash script without shebang": "# Build everything\nset -e\ncd app\nnpm ci\n\n# Run tests\nnpm test\n",
  "bash script with shebang": "#!/bin/bash\n# Deploy\n\n## Config\nNAME=app\necho \"deploying $NAME\"\n",
  "YAML with comments": "# Settings for CI\nname: build\non:\n  push:\n    branches: [main]\n# jobs\njobs:\n  build:\n    runs-on: windows\n",
  "INI file": "; settings\n[core]\nname=kladde\npath=C:\\Tools\n\n[ui]\ntheme=dark\n",
  ".env with comments": "# Database\nDB_HOST=localhost\nDB_PORT=5432\n# Cache\nCACHE_URL=redis://localhost\n",
  "TOML with comments": "# Package\nname = \"kladde\"\nversion = \"0.9.0\"\n\n# Dependencies\n[dependencies]\nserde = \"1\"\n",
  "Dockerfile with comments": "# Build stage\nFROM node:20\n# Install\nRUN apt-get install -y curl\nCOPY . /app\n",
  "JSON object": '{\n  "name": "kladde",\n  "tags": ["a", "b"],\n  "link": "[x](y)"\n}\n',
  "JSON array": '[{"a": 1}, {"a": 2}]',
  "XML": '<?xml version="1.0"?>\n<root>\n  <item id="1">one</item>\n  <item id="2">two</item>\n</root>\n',
  "HTML": "<!DOCTYPE html>\n<html>\n<body>\n<h1>Title</h1>\n<p>Some text with a <b>tag</b>.</p>\n</body>\n</html>\n",
  "HTML fragment": "<div>\n  <p>Hello world, this is text.</p>\n  <ul><li>a</li><li>b</li></ul>\n</div>\n",
  "CSV": "name,age,city\nAnna,31,Berlin\nBob,45,Hamburg\nCarla,28,Köln\n",
  "log output": "2024-05-01 12:00:01 INFO Started [main](x) in 3s\n2024-05-01 12:00:02 WARN Slow request\n2024-05-01 12:00:03 ERROR Failed to open `config`\n",
  "log with levels only": "[INFO] Start\n[WARN] Careful with `x` and `y`\n[ERROR] Failed\n[DEBUG] **done**\n",
  "C# code": "using System;\n\nnamespace App\n{\n    // Entry point\n    public class Program\n    {\n        public static void Main()\n        {\n            Console.WriteLine(\"hi\");\n        }\n    }\n}\n",
  "JavaScript code": "// Utilities\nconst a = 1;\nfunction f(x) {\n  return x * a;\n}\nmodule.exports = { f };\n",
  "SQL": "-- Orders\nSELECT id, total\nFROM orders\nWHERE total > 100;\n\nUPDATE orders SET total = 0 WHERE id = 1;\n",
  "stack trace": "System.NullReferenceException: Object reference not set\n   at App.Program.Main() in C:\\src\\Program.cs:line 12\n   at App.Runner.Run(String[] args) in C:\\src\\Runner.cs:line 7\n",
  "Python traceback": 'Traceback (most recent call last):\n  File "a.py", line 3, in <module>\n    main()\nValueError: bad value\n',
  "git diff": "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # Title\n-- old item\n+- new item\n",
  "unified diff of a list": "--- a/list.txt\n+++ b/list.txt\n@@ -1,2 +1,2 @@\n- milk\n- eggs\n+ bread\n",
  "PowerShell with comments": "# Clean up\n[CmdletBinding()]\nparam([string]$Path)\n\n# Delete files\nRemove-Item -Path $Path -Recurse\n",
  "many comment lines": "# one thing\n# another thing\n# a third thing\n# and a fourth\n",
  "shell commands with prompts": "$ npm ci\n$ npm run build\n$ npm test\n",
  "kwargs snippet": "def f(a, **kwargs, **opts):\n    pass\n",
  "reStructuredText title with a directive": "Title\n=====\n\n.. note:: something\n\n:author: me\n",
  "Makefile with comments": "# Build\nall: main.o\n\tgcc -o app main.o\n\n# Clean\nclean:\n\trm -f *.o\n",
  ".gitignore with comments": "# deps\nnode_modules/\n\n# build\ndist/\n*.log\n",
  "CSS": "/* x */\n.a { color: red; }\n.b { margin: 0; }\n",
  "hosts file": "# Copyright\n#\n# This is a sample HOSTS file\n127.0.0.1 localhost\n",
  "YAML with document marks": "---\nname: build\non: push\n---\nname: other\n",
  "empty": "",
  "whitespace": "  \n\t\n   \n",
  "underlined email line": "Bob\n---\nSent from my phone\n",
};

for (const [name, text] of Object.entries(POSITIVE)) {
  test(`looks like Markdown: ${name}`, () => assert.equal(looksLikeMarkdown(text), true, text));
}

for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`does not look like Markdown: ${name}`, () => assert.equal(looksLikeMarkdown(text), false, text));
}

test("the corpus is big enough", () => {
  assert.ok(Object.keys(POSITIVE).length >= 15 && Object.keys(NEGATIVE).length >= 15);
});

test("only a bounded prefix is read: a huge paste is as cheap as a small one", () => {
  const filler = "plain text without any marks, just a long line of words\n".repeat(20000);
  assert.ok(filler.length > SNIFF_CHARS * 10);
  // Markdown after the prefix is not seen...
  assert.equal(looksLikeMarkdown(filler + "# Title\n\n- a\n- b\n"), false);
  // ... Markdown at the start decides, however much follows.
  assert.equal(looksLikeMarkdown("# Title\n\nA short intro with words.\n\n" + filler), true);
  const start = performance.now();
  looksLikeMarkdown(("# Heading\n\nSome words in a sentence.\n- item\n".repeat(50000)));
  assert.ok(performance.now() - start < 500, "a 2 MB paste is analyzed in well under half a second");
});

test("a cut line at the end of the prefix is ignored", () => {
  // An unterminated fence at the cut would count 2 and the `-` list 1; the half line must not be read as a fence.
  const text = "word ".repeat(SNIFF_CHARS / 5 - 2) + "\n```";
  assert.equal(looksLikeMarkdown(text + "\n".repeat(10) + "x".repeat(100)), false);
});

test("save as: the first extension of the language, txt for plain text", () => {
  assert.equal(saveAsName("new 1", "Markdown"), "new 1.md");
  assert.equal(saveAsName("new 1", null), "new 1.txt");
  assert.equal(saveAsName("new 2", "Python"), "new 2.py");
  assert.equal(saveAsName("new 3", "JSON"), "new 3.json");
  assert.equal(saveAsName("new 4", "Batch"), "new 4.bat");
  assert.equal(saveAsName("new 5", "No Such Language"), "new 5.txt");
});

test("save as: an extension in the title is not doubled", () => {
  assert.equal(saveAsName("notes.md", "Markdown"), "notes.md");
  assert.equal(saveAsName("notes.txt", null), "notes.txt");
  assert.equal(saveAsName("report.py", "Markdown"), "report.py");
  // Not an extension: a version number, nothing after the dot.
  assert.equal(saveAsName("v1.2", "Markdown"), "v1.2.md");
  assert.equal(saveAsName("end.", null), "end..txt");
});
