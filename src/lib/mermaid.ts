// Mermaid diagrams in the Markdown preview.
//
// markdown.ts emits a placeholder for every ```mermaid fence; the preview calls `renderDiagrams` once that
// HTML is in the DOM. Mermaid is large, so it is imported on the first diagram only. The preview re-renders
// after every edit, so finished SVGs are cached by diagram source and theme, and a diagram that is being
// re-rendered keeps showing its previous SVG instead of flickering.

type Mermaid = typeof import("mermaid").default;

type Result = { svg: string } | { error: string };

const MAX_CACHED = 60;
const cache = new Map<string, Promise<Result>>();
let mermaidPromise: Promise<Mermaid> | null = null;
let counter = 0;
// Mermaid renders into shared scratch elements, so renders run one after the other.
let queue: Promise<unknown> = Promise.resolve();

function themeVariables(): { vars: Record<string, string | boolean>; signature: string } {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const css = (name: string) => style.getPropertyValue(name).trim();
  const bg = css("--bg");
  const fg = css("--fg");
  const node = css("--bg-hover");
  const border = css("--accent");
  const line = css("--fg-dim");
  const vars = {
    darkMode: root.classList.contains("dark"),
    background: bg,
    fontFamily: css("--ui-font"),
    primaryColor: node,
    primaryTextColor: fg,
    primaryBorderColor: border,
    secondaryColor: css("--bg-alt"),
    tertiaryColor: css("--bg-alt"),
    lineColor: line,
    textColor: fg,
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: css("--bg-alt"),
    clusterBorder: css("--border"),
    titleColor: fg,
    edgeLabelBackground: bg,
    noteBkgColor: css("--bg-alt"),
    noteTextColor: fg,
    noteBorderColor: border,
    errorBkgColor: css("--bg-alt"),
    errorTextColor: css("--error"),
  };
  return { vars, signature: JSON.stringify(vars) };
}

function getMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((m) => m.default).catch((e) => {
    mermaidPromise = null;
    throw e;
  });
  return mermaidPromise;
}

function renderOne(source: string, vars: Record<string, string | boolean>): Promise<Result> {
  const run = async (): Promise<Result> => {
    const id = `kladde-mermaid-${++counter}`;
    try {
      const mermaid = await getMermaid();
      // "strict" makes Mermaid sanitize labels and ignore directives that could weaken that.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: vars,
        suppressErrorRendering: true,
      });
      const { svg } = await mermaid.render(id, source);
      return { svg };
    } catch (e) {
      // A failed render can leave its scratch element in the page.
      document.getElementById(`d${id}`)?.remove();
      return { error: String((e as Error)?.message ?? e).trim() };
    }
  };
  const result = queue.then(run, run);
  queue = result;
  return result;
}

function cached(source: string, vars: Record<string, string | boolean>, signature: string): Promise<Result> {
  const key = `${signature}\n${source}`;
  let hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh the position, so the oldest entries go first
  } else {
    hit = renderOne(source, vars);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, hit);
  return hit;
}

/** The last SVG shown per diagram position, so an edited diagram does not blink away while it re-renders. */
const lastSvg: string[] = [];
/** The source of each placeholder, kept because drawing the SVG replaces the code block that held it. */
const sources = new WeakMap<HTMLElement, string>();

function show(el: HTMLElement, result: Result, index: number) {
  if ("svg" in result) {
    el.className = "mermaid-block";
    // Mermaid sanitizes its own output in "strict" mode.
    el.innerHTML = result.svg;
    lastSvg[index] = result.svg;
  } else {
    el.className = "mermaid-block mermaid-failed";
    const box = document.createElement("div");
    box.className = "mermaid-error";
    const title = document.createElement("strong");
    title.textContent = "Diagram error";
    const message = document.createElement("pre");
    message.textContent = result.error;
    box.append(title, message);
    el.replaceChildren(box);
    lastSvg[index] = "";
  }
}

/** Turns the diagram placeholders under `root` into SVGs. Resolves after the last one was drawn. */
export async function renderDiagrams(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".mermaid-block[data-mermaid]")];
  lastSvg.length = blocks.length;
  if (!blocks.length) return;
  const { vars, signature } = themeVariables();
  await Promise.all(
    blocks.map(async (el, index) => {
      const source = sources.get(el) ?? el.querySelector("code")?.textContent ?? "";
      sources.set(el, source);
      if (lastSvg[index]) {
        el.className = "mermaid-block mermaid-stale";
        el.innerHTML = lastSvg[index];
      }
      const result = await cached(source, vars, signature);
      if (el.isConnected) show(el, result, index);
    }),
  );
}
