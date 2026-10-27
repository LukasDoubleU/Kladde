// Unit tests for theme selection and the theme sheet. Run: npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { ACCENTS, FLAVORS, THEME_CHOICES, THEME_VARIABLES, isLight, resolveFlavor } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../src/lib/theme.ts")).href
);
const css = readFileSync(resolve(import.meta.dirname, "../../src/themes.css"), "utf8");

test("resolveFlavor: names, old aliases and unknown values", () => {
  assert.equal(resolveFlavor("frappe", "latte", "mocha", true), "frappe");
  assert.equal(resolveFlavor("dark", "latte", "mocha", false), "mocha");
  assert.equal(resolveFlavor("light", "latte", "mocha", true), "latte");
  assert.equal(resolveFlavor("nonsense", "latte", "mocha", true), "mocha");
});

test("resolveFlavor: system follows the Windows mode with a flavor per mode", () => {
  assert.equal(resolveFlavor("system", "latte", "macchiato", false), "latte");
  assert.equal(resolveFlavor("system", "latte", "macchiato", true), "macchiato");
  assert.equal(resolveFlavor("system", "bogus", "bogus", false), "latte");
  assert.equal(resolveFlavor("system", "bogus", "bogus", true), "mocha");
});

test("only Latte is light", () => {
  assert.deepEqual(FLAVORS.filter(isLight), ["latte"]);
});

test("every setting value the app accepts has a stylesheet rule", () => {
  for (const flavor of FLAVORS) {
    if (flavor !== "mocha") assert.match(css, new RegExp(`\[data-theme="${flavor}"\]`), flavor);
  }
  for (const accent of ACCENTS) assert.match(css, new RegExp(`\[data-accent="${accent}"\]`), accent);
  assert.equal(ACCENTS.length, 14);
  assert.ok(THEME_CHOICES.theme.includes("system"));
});

test("every flavor defines the full palette", () => {
  const palette = THEME_VARIABLES[0].names.filter((n) => n !== "--ctp-accent");
  assert.equal(palette.length, 26);
  const blocks = css.split(/\n(?=:root)/).filter((b) => b.includes("--ctp-base:"));
  assert.equal(blocks.length, FLAVORS.length);
  for (const block of blocks) for (const name of palette) assert.ok(block.includes(`${name}:`), name);
});

test("every documented variable is defined", () => {
  for (const { names } of THEME_VARIABLES) for (const name of names) assert.ok(css.includes(`${name}:`), name);
});
