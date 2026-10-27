// Themes: Catppuccin flavors, accents, theme.css and following the Windows mode. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
// Set KLADDE_SHOTS=<folder> to also save a screenshot of every flavor.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-theme");
after(() => removeProfile(profile));

const SHOTS = process.env.KLADDE_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const BASES = { mocha: "rgb(30, 30, 46)", macchiato: "rgb(36, 39, 58)", frappe: "rgb(48, 52, 70)", latte: "rgb(239, 241, 245)" };
const ACCENTS = "rosewater flamingo pink mauve red maroon peach yellow green teal sky sapphire blue lavender".split(" ");

const DOC = `# Themes

Some *emphasis*, **strong** text, a [link](https://example.com) and \`inline code\`.

| Flavor | Mode |
|---|---|
| Mocha | dark |
| Latte | light |

\`\`\`js
// highlighted in the preview
const answer = "forty-two".length + 40;
function hello(name) { return \`hi \${name}\`; }
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Edit] --> B{Preview}
  B -->|yes| C[Diagram]
\`\`\`
`;

/** Computed values of the page, as the user sees them. */
const read = (app) =>
  app.eval(`(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const color = (sel, prop = 'color') => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    return {
      theme: root.dataset.theme, accent: root.dataset.accent, dark: root.classList.contains('dark'),
      scheme: css.colorScheme,
      bg: getComputedStyle(document.body).backgroundColor,
      editorBg: color('.cm-editor', 'backgroundColor'),
      gutterBg: color('.cm-gutters', 'backgroundColor'),
      fg: color('.cm-content'),
      accent_: css.getPropertyValue('--accent').trim(),
      accentFg: css.getPropertyValue('--accent-fg').trim(),
      keyword: color('.markdown .tok-keyword'),
      svg: document.querySelector('.markdown .mermaid-block svg')?.innerHTML ?? '',
    };
  })()`);

/** Replaces the text of the active tab and saves it, like editing a config file. */
async function saveText(app, text) {
  await app.key("Ctrl+A");
  await app.type(text);
  await app.key("Ctrl+S");
}

/** #fff and #ffffff are the same color. */
const hex = (h) => (h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h);
const json = (o) => JSON.stringify(o);
const activeTab = (name) => `document.querySelector('.tab.active .title')?.textContent === '${name}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Contrast ratio of two #rrggbb colors. */
function contrast(a, b) {
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("settings.json switches flavor and accent; theme.css overrides on top", async () => {
  const settings = writeFixture(join(profile, "data"), "settings.json", json({ theme: "dark" }));
  const doc = writeFixture(profile, "doc.md", DOC);
  const app = await launch({ port: 9348, profile, files: [settings, doc] });
  try {
    await app.waitFor("document.querySelectorAll('.tab').length === 2");
    await app.waitFor(activeTab("doc.md"));
    await app.waitFor("document.querySelector('.markdown .mermaid-block svg')", 30000);

    // The old name "dark" is Mocha with Rosewater, exactly the colors of earlier versions.
    let t = await read(app);
    assert.equal(t.theme, "mocha");
    assert.equal(t.accent, "rosewater");
    assert.equal(t.bg, BASES.mocha);
    assert.equal(t.accent_, "#f5e0dc");
    assert.equal(t.dark, true);
    // Alpha colors are built with color-mix now; they must paint the same pixels as the former rgb() values.
    const old = {
      selection: "rgb(147 153 178 / 0.3)",
      "selection-match": "rgb(147 153 178 / 0.15)",
      "active-line": "rgb(205 214 244 / 0.05)",
      "search-match": "rgb(249 226 175 / 0.2)",
      "search-match-border": "rgb(249 226 175 / 0.5)",
      "search-match-selected": "rgb(250 179 135 / 0.4)",
      "bracket-match": "rgb(147 153 178 / 0.25)",
      "diff-del-bg": "rgb(243 139 168 / 0.1)",
      "diff-del-text": "rgb(243 139 168 / 0.3)",
      "diff-add-bg": "rgb(166 227 161 / 0.1)",
      "diff-add-text": "rgb(166 227 161 / 0.28)",
    };
    const painted = await app.eval(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      const el = document.createElement('div');
      document.body.append(el);
      const pixel = (color) => { g.clearRect(0, 0, 1, 1); g.fillStyle = color; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data]; };
      const out = {};
      for (const [name, was] of Object.entries(${JSON.stringify(old)})) {
        el.style.backgroundColor = 'var(--' + name + ')';
        out[name] = { now: pixel(getComputedStyle(el).backgroundColor), was: pixel(was) };
      }
      el.remove();
      return out;
    })()`);
    for (const [name, { now, was }] of Object.entries(painted)) {
      for (let i = 0; i < 4; i++) assert.ok(Math.abs(now[i] - was[i]) <= 1, `--${name}: ${now} instead of ${was}`);
    }
    const mocha = t;

    for (const flavor of ["macchiato", "frappe", "latte", "mocha"]) {
      await app.key("Ctrl+Tab");
      await app.waitFor(activeTab("settings.json"));
      await saveText(app, json({ theme: flavor }));
      await app.waitFor(`document.documentElement.dataset.theme === '${flavor}'`);
      await app.key("Ctrl+Tab");
      await app.waitFor(activeTab("doc.md"));
      await app.waitFor("document.querySelector('.markdown .mermaid-block svg')", 15000);
      await sleep(400);
      t = await read(app);
      assert.equal(t.bg, BASES[flavor], flavor);
      assert.equal(t.editorBg, BASES[flavor], `${flavor} editor`);
      assert.equal(t.gutterBg, BASES[flavor], `${flavor} gutter`);
      assert.equal(t.dark, flavor !== "latte", flavor);
      assert.equal(t.scheme, flavor === "latte" ? "light" : "dark", flavor);
      if (flavor !== "mocha") {
        assert.notEqual(t.svg, mocha.svg, `${flavor}: the diagram is redrawn in the new colors`);
        assert.notEqual(t.keyword, mocha.keyword, `${flavor}: syntax colors follow`);
        assert.notEqual(t.fg, mocha.fg, `${flavor}: text color follows`);
      } else {
        assert.equal(t.keyword, mocha.keyword);
      }
      if (SHOTS) {
        await app.key("Ctrl+F");
        await app.type("answer");
        await app.key("Enter");
        await app.screenshot(join(SHOTS, `${flavor}.png`), { width: 1200, height: 760 });
        await app.key("Escape");
      }
    }

    // The accent changes independently of the flavor; Latte takes white text on blue.
    await app.key("Ctrl+Tab");
    await saveText(app, json({ theme: "latte", accent: "blue" }));
    await app.waitFor("document.documentElement.dataset.accent === 'blue'");
    t = await read(app);
    assert.equal(t.theme, "latte");
    assert.equal(t.accent_, "#1e66f5");
    assert.equal(hex(t.accentFg), "#ffffff");
    if (SHOTS) {
      await app.key("Ctrl+Tab");
      await app.key("Ctrl+Shift+P");
      await app.type("theme");
      await app.screenshot(join(SHOTS, "latte-blue-picker.png"), { width: 1200, height: 760 });
      await app.key("Escape");
      await app.key("Ctrl+Tab");
    }

    // Unknown names fall back to the defaults and say so.
    await saveText(app, json({ theme: "nonsense", accent: "chartreuse" }));
    await app.waitFor("document.querySelector('.notice.error')");
    assert.match(await app.eval("document.querySelector('.notice span').textContent"), /Unknown theme "nonsense", accent "chartreuse"/);
    t = await read(app);
    assert.equal(t.theme, "mocha");
    assert.equal(t.accent, "rosewater");

    // theme.css: created by the command with a commented template, applied when saved.
    await app.key("Ctrl+Shift+P");
    await app.type("custom theme");
    await app.key("Enter");
    await app.waitFor(activeTab("theme.css"));
    // The editor only renders the visible lines, so read the top and the bottom of the file.
    let template = (await app.state()).text;
    await app.key("Ctrl+End");
    template += (await app.state()).text;
    for (const name of ["--ctp-base", "--bg", "--accent-fg", "--diff-add-mark", "--tok-keyword", "--tok-warn"]) {
      assert.ok(template.includes(name), `the template lists ${name}`);
    }
    assert.match(template, /--bg: #1e1e2e;/, "the template shows the values in use");

    // A palette override retints everything built from it; a role variable beats the palette.
    await saveText(app, ":root { --ctp-base: #102030; --tok-keyword: #ff0000; }");
    await app.waitFor("getComputedStyle(document.body).backgroundColor === 'rgb(16, 32, 48)'");
    t = await read(app);
    assert.equal(t.editorBg, "rgb(16, 32, 48)");
    assert.equal(await app.eval("getComputedStyle(document.documentElement).getPropertyValue('--tok-keyword').trim()"), "#ff0000");
    // The preview's code block takes the color too.
    await app.key("Ctrl+Tab");
    await app.waitFor(activeTab("settings.json"));
    await app.key("Ctrl+Tab");
    await app.waitFor(activeTab("doc.md"));
    assert.equal((await read(app)).keyword, "rgb(255, 0, 0)");
    await app.key("Ctrl+Shift+Tab");
    await app.key("Ctrl+Shift+Tab");
    await app.waitFor(activeTab("theme.css"));
    assert.equal(await app.eval("document.querySelector('.notice span')?.textContent"), "Custom theme applied.");
    await app.close();

    // theme.css is applied at the next start, before the window shows; emptying it removes the override.
    const again = await launch({ port: 9381, profile, files: [doc] });
    try {
      await again.waitFor("getComputedStyle(document.body).backgroundColor === 'rgb(16, 32, 48)'");
      // The session (3 tabs) is restored after the theme is applied.
      await again.waitFor("document.querySelectorAll('.tab').length === 3");
      await again.key("Ctrl+Shift+P");
      await again.type("custom theme");
      await again.key("Enter");
      await again.waitFor(activeTab("theme.css"));
      await saveText(again, "/* nothing */");
      await again.waitFor(`getComputedStyle(document.body).backgroundColor === '${BASES.mocha}'`);
    } finally {
      await again.kill();
    }
  } finally {
    await app.kill();
  }
});

test("system follows the Windows light/dark mode with a flavor per mode", async () => {
  const p = tempProfile("kladde-theme-system");
  writeFixture(join(p, "data"), "settings.json", json({ theme: "system", themeLight: "latte", themeDark: "frappe" }));
  const app = await launch({ port: 9382, profile: p });
  try {
    const mode = (scheme) => app.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await mode("dark");
    await app.waitFor("document.documentElement.dataset.theme === 'frappe'");
    assert.equal((await read(app)).bg, BASES.frappe);
    await mode("light");
    await app.waitFor("document.documentElement.dataset.theme === 'latte'");
    assert.equal((await read(app)).bg, BASES.latte);
    await mode("dark");
    await app.waitFor("document.documentElement.dataset.theme === 'frappe'");
  } finally {
    await app.kill();
    await removeProfile(p);
  }
});

test("--accent-fg is readable on every accent of every flavor", async () => {
  const p = tempProfile("kladde-theme-contrast");
  const app = await launch({ port: 9383, profile: p });
  try {
    const rows = await app.eval(`(() => {
      const root = document.documentElement;
      const out = [];
      for (const theme of ${JSON.stringify(Object.keys(BASES))}) {
        for (const accent of ${JSON.stringify(ACCENTS)}) {
          root.dataset.theme = theme;
          root.dataset.accent = accent;
          const css = getComputedStyle(root);
          out.push([theme, accent, css.getPropertyValue('--accent').trim(), css.getPropertyValue('--accent-fg').trim()]);
        }
      }
      return out;
    })()`);
    assert.equal(rows.length, 4 * 14);
    for (const [theme, accent, bg, fg] of rows) {
      assert.match(bg, /^#[0-9a-f]{6}$/, `${theme} ${accent}`);
      assert.ok(contrast(bg, hex(fg)) >= 4.5, `${theme} ${accent}: ${fg} on ${bg} is ${contrast(bg, hex(fg)).toFixed(1)}`);
    }
  } finally {
    await app.kill();
    await removeProfile(p);
  }
});
