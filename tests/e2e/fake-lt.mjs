// The part of a LanguageTool stand-in that decides what is a finding, shared by the in-process fake of
// grammar.test.mjs and the separate process of fake-languagetool.mjs (which Kladde starts as its local server).

export const lt = (offset, length, id, issueType, category, replacements, message) => ({
  offset,
  length,
  message,
  replacements: replacements.map((value) => ({ value })),
  rule: { id, issueType, category: { id: category } },
});

/** The text LanguageTool would read: markup does not count as text but keeps its length. */
export const readable = (annotation) => annotation.map((i) => i.text ?? " ".repeat(i.markup.length)).join("");

/** Flags "eror" (spelling) and "This are" (grammar). */
export function matchesIn(text) {
  const matches = [];
  for (const m of text.matchAll(/\beror\b/g)) {
    matches.push(lt(m.index, 4, "MORFOLOGIK_RULE_EN_US", "misspelling", "TYPOS", ["error"], "Possible spelling mistake found."));
  }
  for (const m of text.matchAll(/This (are)\b/g)) {
    matches.push(lt(m.index + 5, 3, "PLURAL_VERB_AFTER_THIS", "grammar", "GRAMMAR", ["is"], "The verb 'are' is plural."));
  }
  return matches;
}
