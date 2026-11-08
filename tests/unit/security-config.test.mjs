// Unit tests for the security settings in tauri.conf.json: the CSP and the asset protocol scope. Run: npm run test:unit
// The behavior itself (a form that cannot navigate, an HTML file the asset protocol refuses) is covered by
// tests/e2e/navigation.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { IMAGE_EXTENSIONS } = await import(pathToFileURL(resolve(import.meta.dirname, "../../src/lib/languages.ts")).href);
const conf = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../src-tauri/tauri.conf.json"), "utf8"));
const security = conf.app.security;

test("the CSP forbids form submissions and a base URL, which do not fall back to default-src", () => {
  assert.equal(security.csp["form-action"], "'none'");
  assert.equal(security.csp["base-uri"], "'none'");
  assert.equal(security.csp["default-src"], "'self'");
  assert.equal(security.csp["script-src"], "'self'");
});

test("the asset protocol serves image files only: the image tab's types and SVG for the Markdown preview", () => {
  // One pattern per extension, in lower case: Tauri matches scope globs case-insensitively (its glob options are
  // the crate's defaults), which tests/e2e/navigation.test.mjs pins with PHOTO.PNG.
  const expected = [...IMAGE_EXTENSIONS, "svg"].map((ext) => `**/*.${ext}`).sort();
  assert.deepEqual([...security.assetProtocol.scope].sort(), expected);
});

test("no asset scope pattern can match a document type", () => {
  const documents = ["html", "htm", "xhtml", "pdf", "txt", "xml", "js", "mjs", "json", "css", "md"];
  for (const glob of security.assetProtocol.scope) {
    assert.match(glob, /^\*\*\/\*\.[a-z]+$/, glob);
    assert.ok(!documents.includes(glob.split(".").pop()), glob);
  }
});
