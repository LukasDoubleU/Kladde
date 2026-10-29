// Unit tests for the settings metadata that the settings page is built from. Run: npm run test:unit
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const load = (name) => import(pathToFileURL(resolve(import.meta.dirname, "../../src/lib", name)).href);
const { SETTING_GROUPS, SETTING_META, coerceSetting, defaultSettings, settingMatches, settingNames } = await load("settings-schema.ts");

const names = Object.keys(defaultSettings);

test("every setting has metadata, and nothing else has", () => {
  assert.deepEqual(Object.keys(SETTING_META).sort(), [...names].sort());
  assert.deepEqual([...settingNames()].sort(), [...names].sort());
});

test("every setting has a group, a label, a description and a control that fits its default", () => {
  const groups = SETTING_GROUPS.map((g) => g.id);
  const labels = new Set();
  for (const name of names) {
    const meta = SETTING_META[name];
    const value = defaultSettings[name];
    assert.ok(groups.includes(meta.group), `${name}: unknown group ${meta.group}`);
    assert.ok(meta.label.trim(), `${name}: no label`);
    assert.ok(meta.description.trim().length > 10, `${name}: no description`);
    assert.equal(labels.has(meta.label), false, `${name}: label ${meta.label} is not unique`);
    labels.add(meta.label);
    const c = meta.control;
    switch (c.type) {
      case "boolean":
        assert.equal(typeof value, "boolean", name);
        break;
      case "number":
        assert.equal(typeof value, "number", name);
        assert.ok(c.min <= value && value <= c.max, `${name}: default outside ${c.min}..${c.max}`);
        break;
      case "choice":
        assert.equal(typeof value, "string", name);
        assert.ok(c.choices.some((x) => x.value === value), `${name}: default is not among the choices`);
        assert.equal(new Set(c.choices.map((x) => x.value)).size, c.choices.length, `${name}: duplicate choices`);
        break;
      case "text":
        assert.equal(typeof value, "string", name);
        break;
      default:
        assert.fail(`${name}: unknown control ${c.type}`);
    }
  }
  for (const g of groups) assert.ok(names.some((n) => SETTING_META[n].group === g), `empty group ${g}`);
});

test("the page lists settings group by group", () => {
  const rank = (n) => SETTING_GROUPS.findIndex((g) => g.id === SETTING_META[n].group);
  const ranks = settingNames().map(rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("choices are what the app accepts", async () => {
  const { THEME_CHOICES } = await load("theme.ts");
  for (const name of Object.keys(THEME_CHOICES)) {
    for (const choice of SETTING_META[name].control.choices) {
      assert.ok(THEME_CHOICES[name].includes(choice.value), `${name}: ${choice.value}`);
    }
  }
  const { KEYMAPS } = await load("keymaps.ts");
  assert.deepEqual(
    SETTING_META.keymap.control.choices.map((c) => c.value),
    Object.keys(KEYMAPS),
  );
  assert.deepEqual(SETTING_META.markdownPreview.control.choices.map((c) => c.value).sort(), ["off", "only", "split"]);
});

test("search finds a setting by label, description, name and section", () => {
  const found = (q) => settingNames().filter((n) => settingMatches(n, q));
  assert.deepEqual(found(""), settingNames());
  assert.deepEqual(found("tab size"), ["tabSize"]);
  assert.ok(found("ligatures").includes("fontLigatures"));
  assert.deepEqual(found("largefilethreshold"), ["largeFileThresholdMB"]);
  assert.ok(found("LANGUAGETOOL").includes("languageToolServer"));
  assert.ok(found("GitHub").includes("checkForUpdates"), "description");
  assert.deepEqual(found("windows integration"), ["offerDefaultEditor"]);
  assert.deepEqual(found("catppuccin nonsense"), []);
  // Every word must match, in any order.
  assert.deepEqual(found("size tab"), ["tabSize"]);
});

test("values from the controls are brought into range and type", () => {
  assert.equal(coerceSetting("fontSize", "20"), 20);
  assert.equal(coerceSetting("fontSize", "999"), 72);
  assert.equal(coerceSetting("fontSize", "1"), 6);
  assert.equal(coerceSetting("fontSize", "13.6"), 14);
  assert.equal(coerceSetting("fontSize", ""), null);
  assert.equal(coerceSetting("fontSize", "abc"), null);
  assert.equal(coerceSetting("wordWrap", true), true);
  assert.equal(coerceSetting("wordWrap", "true"), null);
  assert.equal(coerceSetting("accent", "mauve"), "mauve");
  assert.equal(coerceSetting("accent", "plaid"), null);
  assert.equal(coerceSetting("pasteImageFolder", "  img "), "img");
  assert.equal(coerceSetting("languageToolServer", ""), "");
});
