<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { tick } from "svelte";
  import { resolvePath } from "../lib/markdown";
  import { renderDiagrams } from "../lib/mermaid";
  import { workspace } from "../lib/workspace.svelte";

  let { html, baseDir, follow }: { html: string; baseDir: string | null; follow: boolean } = $props();

  let pane: HTMLDivElement;

  /** Scrolls the preview to the part of the document at the top of the editor. */
  function sync() {
    if (!pane || !follow) return;
    const { line, fraction } = workspace.topVisibleLine();
    const source = line - 1 + fraction;
    if (source <= 0) {
      pane.scrollTop = 0;
      return;
    }
    const blocks = pane.querySelectorAll<HTMLElement>("[data-line]");
    let before: HTMLElement | null = null;
    let after: HTMLElement | null = null;
    for (const block of blocks) {
      if (Number(block.dataset.line) <= source) before = block;
      else {
        after = block;
        break;
      }
    }
    if (!before) return;
    const offset = (el: HTMLElement) => el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    const startLine = Number(before.dataset.line);
    const top = offset(before);
    const endLine = after ? Number(after.dataset.line) : workspace.cursor.lines;
    const bottom = after ? offset(after) : pane.scrollHeight;
    const progress = Math.min(1, (source - startLine) / Math.max(1, endLine - startLine));
    pane.scrollTop = top + progress * (bottom - top) - 12;
  }

  $effect(() => {
    workspace.onEditorScroll = sync;
    return () => (workspace.onEditorScroll = () => {});
  });

  /** Draws the Mermaid diagrams; their height changes the layout, so the scroll position is synced again. */
  function drawDiagrams() {
    if (pane) void renderDiagrams(pane).then(sync);
  }

  $effect(() => {
    void html;
    void tick().then(() => {
      sync();
      drawDiagrams();
    });
  });

  // Diagram colors follow the theme, which is switched by a class on the root element.
  $effect(() => {
    const observer = new MutationObserver(drawDiagrams);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  });

  function onClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      pane.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
    } else if (/^(https?:|mailto:)/i.test(href)) {
      void openUrl(href);
    } else if (href && baseDir) {
      void workspace.openPath(resolvePath(baseDir, decodeURIComponent(href.split(/[?#]/)[0])));
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="preview" bind:this={pane} onclick={onClick}>
  <article class="markdown">
    {@html html}
  </article>
</div>

<style>
  .preview {
    height: 100%;
    overflow: auto;
    background: var(--bg);
  }
  .markdown {
    max-width: 860px;
    margin: 0 auto;
    padding: 16px 28px 40vh;
    font-family: var(--ui-font);
    font-size: calc(var(--editor-font-size) + 1px);
    line-height: 1.6;
    color: var(--fg);
    word-wrap: break-word;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: 1.4em 0 0.6em;
    line-height: 1.25;
    font-weight: 600;
  }
  .markdown :global(h1) {
    font-size: 2em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }
  .markdown :global(h2) {
    font-size: 1.5em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }
  .markdown :global(h3) {
    font-size: 1.25em;
  }
  .markdown :global(> :first-child) {
    margin-top: 0;
  }
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol),
  .markdown :global(blockquote),
  .markdown :global(table),
  .markdown :global(pre) {
    margin: 0 0 1em;
  }
  .markdown :global(a) {
    color: var(--link);
    text-decoration: none;
  }
  .markdown :global(a:hover) {
    text-decoration: underline;
  }
  .markdown :global(img) {
    max-width: 100%;
    border-radius: 3px;
  }
  .markdown :global(code) {
    font-family: var(--editor-font);
    font-size: 0.88em;
    background: var(--bg-alt);
    border-radius: 4px;
    padding: 0.15em 0.35em;
  }
  .markdown :global(pre) {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
    overflow-x: auto;
    line-height: 1.45;
  }
  .markdown :global(pre code) {
    background: none;
    padding: 0;
    font-size: 0.88em;
  }
  .markdown :global(blockquote) {
    padding: 0 1em;
    color: var(--fg-dim);
    border-left: 4px solid var(--border);
  }
  .markdown :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--border);
    padding: 5px 12px;
  }
  .markdown :global(th) {
    background: var(--bg-alt);
  }
  .markdown :global(hr) {
    border: none;
    border-top: 2px solid var(--border);
    margin: 1.6em 0;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    padding-left: 2em;
  }
  .markdown :global(li.task-list-item) {
    list-style: none;
  }
  .markdown :global(li.task-list-item input) {
    margin: 0 0.4em 0 -1.4em;
    vertical-align: middle;
  }
  .markdown :global(.mermaid-block) {
    margin: 0 0 1em;
    text-align: center;
    overflow-x: auto;
  }
  .markdown :global(.mermaid-block > pre) {
    margin: 0;
    text-align: left;
    opacity: 0.55;
  }
  .markdown :global(.mermaid-block svg) {
    max-width: 100%;
    height: auto;
  }
  .markdown :global(.mermaid-block.mermaid-stale) {
    opacity: 0.6;
  }
  .markdown :global(.mermaid-error) {
    text-align: left;
    padding: 8px 12px;
    border: 1px solid var(--error);
    border-radius: 6px;
    background: var(--bg-alt);
  }
  .markdown :global(.mermaid-error strong) {
    color: var(--error);
  }
  .markdown :global(.mermaid-error pre) {
    margin: 4px 0 0;
    padding: 0;
    border: none;
    background: none;
    white-space: pre-wrap;
    font-family: var(--editor-font);
    font-size: 0.85em;
  }
  .markdown :global(.math-block) {
    margin: 0 0 1em;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .markdown :global(.math-pending) {
    font-family: var(--editor-font);
    color: var(--fg-dim);
  }
  .markdown :global(.math-error) {
    font-family: var(--editor-font);
    color: var(--error);
    cursor: help;
  }
  .markdown :global(.svg-preview) {
    display: grid;
    place-items: center;
    min-height: 60vh;
  }
  .markdown :global(.svg-preview img) {
    max-width: 100%;
    max-height: 80vh;
  }
</style>
