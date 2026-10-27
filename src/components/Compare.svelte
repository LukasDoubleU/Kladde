<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { readOnlyViewExtensions } from "../lib/editor";
  import { settings } from "../lib/settings.svelte";
  import { workspace, type Tab } from "../lib/workspace.svelte";
  // Only a type: the diff code (@codemirror/merge) is imported when the first compare tab opens.
  import type { CompareHandle } from "../lib/compare";

  let { tab, active }: { tab: Tab; active: boolean } = $props();

  const data = $derived(workspace.compareOf(tab.id)!);
  const options = workspace.compareOptions;

  let host: HTMLDivElement;
  let handle: CompareHandle | null = null;
  let generation = 0;
  let first = true;
  let destroyed = false;

  async function build(opts: typeof options) {
    const mine = ++generation;
    const [{ createCompare }, lang] = await Promise.all([import("../lib/compare"), workspace.languageExtension(tab.language)]);
    // Another rebuild or the tab closing overtook this one.
    if (mine !== generation || destroyed) return;
    const scrollTop = handle?.scrollTop ?? 0;
    handle?.destroy();
    const extensions = readOnlyViewExtensions({ wordWrap: workspace.ui.wordWrap, tabSize: settings.tabSize }, lang);
    handle = createCompare(host, data.left.text, data.right.text, extensions, { ...opts });
    workspace.registerCompare(tab.id, handle);
    workspace.compareChanges[tab.id] = handle.changes;
    if (first) {
      first = false;
      handle.showFirst();
    } else {
      handle.scrollTop = scrollTop;
    }
    if (active) focusView();
  }

  $effect(() => {
    // Rebuild whenever one of the controls changes.
    const opts = { ignoreWhitespace: options.ignoreWhitespace, ignoreCase: options.ignoreCase, unified: options.unified };
    untrack(() => void build(opts));
  });

  // The right editor (or the only one) gets the focus, so F7 and the arrow keys work right away.
  function focusView() {
    requestAnimationFrame(() => [...(host?.querySelectorAll<HTMLElement>(".cm-content") ?? [])].pop()?.focus());
  }

  $effect(() => {
    if (active) focusView();
  });

  onDestroy(() => {
    destroyed = true;
    workspace.registerCompare(tab.id, null);
    handle?.destroy();
  });
</script>

<div class="compare" class:hidden={!active}>
  <div class="toolbar">
    <button title="Previous change" onclick={() => workspace.compareStep(-1)}>↑ Previous</button>
    <button title="Next change" onclick={() => workspace.compareStep(1)}>↓ Next</button>
    <span class="sep"></span>
    <label><input type="checkbox" bind:checked={options.ignoreWhitespace} /> Ignore whitespace</label>
    <label><input type="checkbox" bind:checked={options.ignoreCase} /> Ignore case</label>
    <span class="sep"></span>
    <label><input type="checkbox" bind:checked={options.unified} /> Inline</label>
  </div>
  <div class="labels" class:unified={options.unified}>
    {#if options.unified}
      <span title={data.left.label}>{data.left.label}</span>
      <span class="arrow">→</span>
      <span title={data.right.label}>{data.right.label}</span>
    {:else}
      <span title={data.left.label}>{data.left.label}</span>
      <span title={data.right.label}>{data.right.label}</span>
    {/if}
  </div>
  <div class="host" bind:this={host}></div>
</div>

<style>
  .compare {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
  }
  .compare.hidden {
    display: none;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 10px;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    flex: none;
    user-select: none;
  }
  .toolbar button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 4px;
    padding: 1px 10px;
  }
  .toolbar button:hover {
    background: var(--bg-hover);
  }
  .toolbar label {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--border);
  }
  .labels {
    display: flex;
    flex: none;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    color: var(--fg-dim);
    user-select: none;
  }
  .labels span {
    flex: 1 1 0;
    min-width: 0;
    padding: 2px 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .labels.unified span {
    flex: 0 1 auto;
  }
  .labels .arrow {
    padding: 2px 0;
    flex: none;
  }
  .host {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .host :global(.cm-mergeView),
  .host :global(.cm-editor) {
    height: 100%;
  }
  .host :global(.cm-mergeView .cm-editor) {
    height: auto;
  }

  /* Change colors from the theme variables; they replace the merge package's fixed light/dark colors. */
  .host :global(.cm-merge-a .cm-changedLine),
  .host :global(.cm-deletedChunk) {
    background-color: var(--diff-del-bg) !important;
  }
  .host :global(.cm-merge-b .cm-changedLine),
  .host :global(.cm-inlineChangedLine) {
    background-color: var(--diff-add-bg) !important;
  }
  .host :global(.cm-merge-a .cm-changedText),
  .host :global(.cm-deletedChunk .cm-deletedText) {
    background: var(--diff-del-text) !important;
  }
  .host :global(.cm-merge-b .cm-changedText),
  .host :global(.cm-merge-b .cm-deletedText) {
    background: var(--diff-add-text) !important;
  }
  .host :global(.cm-merge-a .cm-changedLineGutter),
  .host :global(.cm-deletedLineGutter) {
    background: var(--diff-del-mark) !important;
  }
  .host :global(.cm-merge-b .cm-changedLineGutter),
  .host :global(.cm-inlineChangedLineGutter) {
    background: var(--diff-add-mark) !important;
  }
  .host :global(.cm-editor.cm-focused) {
    outline: none;
  }
  .host :global(.cm-changeGutter) {
    width: 4px;
  }
  /* The gutter of the editor's own theme sets a border; the change marker sits next to it. */
  .host :global(.cm-mergeViewEditor + .cm-mergeViewEditor) {
    border-left: 1px solid var(--border);
  }
</style>
