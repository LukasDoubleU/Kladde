// Preview: Mermaid diagrams and KaTeX math. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-preview");
const second = tempProfile("kladde-preview2");
after(() => Promise.all([removeProfile(profile), removeProfile(second)]));

const DOC = `# Diagrams and math

Inline math $E = mc^2$ and a price of $5 and $10 stay apart.

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\`\`\`math
\\sqrt{a^2 + b^2}
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Edit] --> B{Preview}
  B -->|valid| C[Diagram]
  B -->|invalid| D[Error box]
\`\`\`

\`\`\`mermaid
flowchart LR
  A -->
  this is not a diagram ((
\`\`\`

\`\`\`js
const code = "stays highlighted";
\`\`\`
`;

test("renders Mermaid diagrams, math and error boxes", async () => {
  const file = writeFixture(profile, "diagrams.md", DOC);
  const app = await launch({ port: 9346, profile, files: [file] });
  try {
    await app.waitFor("document.querySelector('.tab.active .title')?.textContent === 'diagrams.md'");
    // Diagram and math chunks are loaded on demand, so give them time.
    await app.waitFor("document.querySelectorAll('.markdown .mermaid-block svg').length === 1", 20000);
    await app.waitFor("document.querySelector('.markdown .mermaid-error')", 20000);
    await app.waitFor("document.querySelectorAll('.markdown .katex').length >= 3", 20000);

    const result = await app.eval(`({
      svgs: document.querySelectorAll('.markdown .mermaid-block svg').length,
      labels: [...document.querySelectorAll('.markdown .mermaid-block svg')].map((s) => s.textContent).join(' '),
      error: document.querySelector('.markdown .mermaid-error pre')?.textContent ?? '',
      katex: document.querySelectorAll('.markdown .katex').length,
      display: document.querySelectorAll('.markdown .katex-display').length,
      price: [...document.querySelectorAll('.markdown p')].some((p) => p.textContent.includes('$5 and $10')),
      lines: [...document.querySelectorAll('.markdown .mermaid-block, .markdown .math-block')].every((e) => e.dataset.line !== undefined && e.dataset.line !== ''),
      highlighted: document.querySelectorAll('.markdown pre code span').length > 0,
    })`);
    assert.equal(result.svgs, 1);
    assert.match(result.labels, /Preview/);
    assert.notEqual(result.error, "");
    assert.equal(result.katex, 3, "one inline and two display formulas");
    assert.equal(result.display, 2);
    assert.ok(result.price, "prices are not math");
    assert.ok(result.lines, "diagrams and display math keep data-line for scroll sync");
    assert.ok(result.highlighted, "other code blocks are still highlighted");

    // The profile is deleted afterwards, so the screenshot goes next to it.
    const shot = join(tmpdir(), "kladde-preview-dark.png");
    await app.screenshot(shot, { width: 1000, height: 900 });
    console.log("screenshot:", shot);
  } finally {
    await app.kill();
  }
});

test("a diagram follows edits and the theme", async () => {
  const file = writeFixture(second, "edit.md", "```mermaid\nflowchart LR\n  A --> B\n```\n");
  const app = await launch({ port: 9376, profile: second, files: [file] });
  try {
    await app.waitFor("document.querySelectorAll('.markdown .mermaid-block svg').length === 1", 20000);
    const fill = () => app.eval(`getComputedStyle(document.querySelector('.markdown .mermaid-block svg .node rect, .markdown .mermaid-block svg .node polygon')).fill`);
    const dark = await fill();

    // Typing at the end of the file changes the diagram source.
    await app.click(".cm-content");
    await app.key("Ctrl+Home");
    await app.key("Down");
    await app.key("End");
    await app.type("\n  B --> C");
    await app.waitFor("document.querySelector('.markdown .mermaid-block svg')?.textContent.includes('C')", 20000);

    // Switching the theme redraws with the light palette.
    await app.eval(`document.documentElement.classList.remove('dark')`);
    await app.waitFor(
      `getComputedStyle(document.querySelector('.markdown .mermaid-block svg .node rect, .markdown .mermaid-block svg .node polygon')).fill !== ${JSON.stringify(dark)}`,
      20000,
    );
  } finally {
    await app.kill();
  }
});
