// Makes the rendered DOM of a document safe to attach: nothing in it may make the WebView request another resource.
// A document is untrusted text, and the viewer's renderer builds CSS and style attributes from it (font names are
// pasted into rules, VML shapes copy their `style` unchanged). The CSP lets images in from any https address, so
// this is what keeps a document from phoning home; it runs on nodes that are not attached yet, so nothing has
// been fetched when it starts. The CSS is judged through the browser's own parser (CSSOM) and `css-scan.ts`.
import { isDataUrl, referencesRemote, splitDeclarations } from "./css-scan";

export interface CleanStats {
  /** Declarations, rules, attributes and elements taken out. */
  removed: number;
}

// Elements that load or run something; a document has no use for them in a preview.
const FORBIDDEN = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base", "form", "video",
  "audio", "source", "track", "portal", "fencedframe",
]);
// Attributes that hold an address. On links (`a`) the address is only shown and opened by the user's click.
const ADDRESS_ATTRIBUTES = new Set(["src", "srcset", "href", "xlink:href", "poster", "data", "background", "longdesc", "ping", "action", "formaction", "usemap", "cite"]);

/** Removes the declarations of a block that refer to something other than `data:`. */
function cleanDeclarations(style: CSSStyleDeclaration, stats: CleanStats) {
  for (const { name, value } of splitDeclarations(style.cssText)) {
    if (referencesRemote(value)) {
      style.removeProperty(name);
      stats.removed++;
    }
  }
}

function cleanRules(rules: CSSRuleList, stats: CleanStats) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    const parent = rule.parentRule ?? rule.parentStyleSheet;
    const drop = () => {
      (parent as CSSGroupingRule | CSSStyleSheet).deleteRule(i);
      stats.removed++;
    };
    if (rule instanceof CSSImportRule || rule instanceof CSSPropertyRule) {
      drop();
      continue;
    }
    if ("style" in rule) {
      cleanDeclarations((rule as CSSStyleRule).style, stats);
      // A font without its source (a remote one was removed) is no font.
      if (rule instanceof CSSFontFaceRule && !rule.style.getPropertyValue("src")) {
        drop();
        continue;
      }
    }
    if ("cssRules" in rule) cleanRules((rule as CSSGroupingRule).cssRules, stats);
  }
}

/** The CSS text of a `<style>` made safe, or null when the text is empty. */
function cleanStyleText(text: string, stats: CleanStats): string {
  // A constructable sheet is not attached to anything and ignores `@import`, so parsing it fetches nothing.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  cleanRules(sheet.cssRules, stats);
  return Array.from(sheet.cssRules, (r) => r.cssText).join("\n");
}

function cleanElement(el: Element, stats: CleanStats) {
  const tag = el.localName.toLowerCase();
  if (FORBIDDEN.has(tag)) {
    el.remove();
    stats.removed++;
    return;
  }
  if (tag === "style") {
    el.textContent = cleanStyleText(el.textContent ?? "", stats);
    return;
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      stats.removed++;
    } else if (name === "style") {
      cleanDeclarations((el as HTMLElement).style, stats);
    } else if (ADDRESS_ATTRIBUTES.has(name)) {
      // Links keep their address (opened only on a click, through Kladde's link handling); anything else that
      // takes an address must carry its bytes itself.
      if (tag === "a" && (name === "href" || name === "xlink:href")) continue;
      if (!isDataUrl(attr.value)) {
        el.removeAttribute(attr.name);
        stats.removed++;
      }
    } else if (tag === "a" && (name === "target" || name === "download")) {
      el.removeAttribute(attr.name);
    }
  }
  // An image without a source of its own has nothing to show (and `src="null"` would ask the app's own origin).
  if ((tag === "img" && !el.hasAttribute("src")) || (tag === "image" && !el.hasAttribute("href") && !el.hasAttribute("xlink:href"))) {
    el.remove();
    stats.removed++;
  }
}

/** Cleans the nodes a renderer returned (detached), in place. */
export function cleanDocumentNodes(nodes: Node[]): CleanStats {
  const stats: CleanStats = { removed: 0 };
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    // The tree is walked before changing it, so removing an element does not disturb the walk.
    const all = [node, ...node.querySelectorAll("*")];
    for (const el of all) cleanElement(el, stats);
  }
  return stats;
}
