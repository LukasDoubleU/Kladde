// Makes the rendered DOM of a document safe to attach: nothing in it may make the WebView request another resource.
// A document is untrusted text, and the viewer's renderer builds CSS and style attributes from it (font names are
// pasted into rules, VML shapes copy their `style` unchanged). This is the second layer: the first is the policy of
// the frame the document is shown in (`FRAME_CSP`, nothing but `data:` images and fonts), which holds whatever this
// misses. It still runs, on nodes that are not attached yet, and it keeps the DOM small. The CSS is judged through the browser's own parser (CSSOM) and `css-scan.ts`.
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

// A custom property is pasted into other declarations by `var()`, so a string in it can become an address (inside
// `image-set()`) wherever it ends up: judged as if every string were one. (A name with an escape could be any.)
const isCustomProperty = (name: string) => name.startsWith("--") || name.includes("\\");

/** Removes the declarations of a block that refer to something other than `data:`. */
function cleanDeclarations(style: CSSStyleDeclaration, stats: CleanStats) {
  const remote = () => splitDeclarations(style.cssText).filter((d) => referencesRemote(d.value, isCustomProperty(d.name)));
  for (const { name } of remote()) {
    style.removeProperty(name);
    stats.removed++;
  }
  // Whatever could not be removed by name takes the whole block with it.
  if (remote().length > 0) {
    style.cssText = "";
    stats.removed++;
  }
}

/**
 * Whether a rule's selector (or the prelude of `@scope`) names a shadow host: `:host`, `:host()`, `:host-context()`.
 * The viewer used to render into a shadow root, where such a rule restyled Kladde's own element. The frame has no
 * host, so the rules are inert now; they are still dropped, because nothing of a document needs them.
 */
function targetsHost(rule: CSSRule): boolean {
  if (rule.constructor.name === "CSSScopeRule") return true;
  return rule instanceof CSSStyleRule && /:host/i.test(rule.selectorText);
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
    // See `targetsHost`.
    if (targetsHost(rule)) {
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
    } else if (!isDataUrl(attr.value) && referencesRemote(attr.value)) {
      // Paint and reference attributes of SVG shapes (`fill`, `stroke`, `filter`, `mask`, `clip-path`, markers): the
      // engine copies a VML shape's colors into them unchanged, and `url(https://…)` there is fetched.
      el.removeAttribute(attr.name);
      stats.removed++;
    }
  }
  // An image without a source of its own has nothing to show (and `src="null"` would ask the app's own origin).
  if (tag === "img" && !el.hasAttribute("src")) {
    el.remove();
    stats.removed++;
  } else if (tag === "image" && !el.hasAttribute("href") && !el.hasAttribute("xlink:href")) {
    // An empty group instead of nothing: the engine measures the first child of a VML shape's `<svg>` a frame
    // later (`getBBox`) and fails on a shape without one.
    el.replaceWith(el.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g"));
    stats.removed++;
  }
}

/** Cleans the nodes a renderer returned (made by the frame's document, not attached yet), in place. */
export function cleanDocumentNodes(nodes: Node[]): CleanStats {
  const stats: CleanStats = { removed: 0 };
  for (const node of nodes) {
    // Not `instanceof Element`: the nodes are made by the frame's document, whose classes are not the page's.
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    // The tree is walked before changing it, so removing an element does not disturb the walk.
    const all = [node as Element, ...(node as Element).querySelectorAll("*")];
    for (const el of all) cleanElement(el, stats);
  }
  return stats;
}
