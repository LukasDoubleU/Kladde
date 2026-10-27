<script lang="ts">
  import { runAction } from "../lib/actions";
  import { workspace } from "../lib/workspace.svelte";

  let { imageSize }: { imageSize: { w: number; h: number } | null } = $props();

  const tab = $derived(workspace.active);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
  }

  function encodingLabel(encoding: string, bom: boolean) {
    if (encoding === "UTF-8") return bom ? "UTF-8 BOM" : "UTF-8";
    if (encoding === "windows-1252") return "ANSI (1252)";
    return encoding;
  }
</script>

<footer>
  {#if tab?.kind === "text"}
    <span>Ln {workspace.cursor.line}, Col {workspace.cursor.col}</span>
    {#if workspace.cursor.selected > 0}
      <span>
        {workspace.cursor.selected} selected{workspace.cursor.selections > 1 ? ` in ${workspace.cursor.selections}` : ""}
      </span>
    {/if}
    <span class="dim">{workspace.cursor.lines.toLocaleString()} lines</span>
    {#if tab.binary}<span class="warn" title="The file contains NUL bytes">binary</span>{/if}
  {:else if tab?.kind === "large"}
    <span>
      {workspace.largeStatus.lines.toLocaleString()} lines{workspace.largeStatus.done ? "" : " (indexing…)"}
    </span>
    <span class="dim">{formatSize(tab.size)}</span>
    <span class="dim">Read-only: large file viewer</span>
  {:else if tab?.kind === "image"}
    {#if imageSize}<span>{imageSize.w} × {imageSize.h}</span>{/if}
    <span class="dim">{formatSize(tab.size)}</span>
  {/if}

  <span class="spacer"></span>

  {#if workspace.ui.zoom !== 0}
    <button title="Reset zoom (Ctrl+0)" onclick={() => workspace.zoom(null)}>
      {workspace.ui.zoom > 0 ? "+" : ""}{workspace.ui.zoom} pt
    </button>
  {/if}
  {#if tab?.kind === "text"}
    {#if workspace.previewAvailable(tab)}
      <button title="Toggle preview (Ctrl+Shift+V)" onclick={() => workspace.togglePreview()}>
        Preview: {tab.preview === "off" ? "off" : tab.preview === "split" ? "side by side" : "only"}
      </button>
    {/if}
    <button title="Toggle word wrap (Alt+Z)" onclick={() => workspace.toggleWrap()}>
      {workspace.ui.wordWrap ? "Wrap" : "No wrap"}
    </button>
    <button title="Select language" onclick={() => runAction("language.select")}>{tab.language ?? "Plain Text"}</button>
    <button title="Line endings" onclick={() => runAction("eol.select")}>{tab.eol}</button>
    <button title="Encoding" onclick={() => runAction("encoding.select")}>{encodingLabel(tab.encoding, tab.bom)}</button>
  {:else if tab?.kind === "large"}
    <span>{encodingLabel(tab.encoding, false)}</span>
  {/if}
</footer>

<style>
  footer {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 24px;
    padding: 0 6px;
    flex: none;
    background: var(--bg-alt);
    border-top: 1px solid var(--border);
    color: var(--fg);
    font-size: 12px;
    white-space: nowrap;
    user-select: none;
  }
  span,
  button {
    padding: 0 8px;
    line-height: 22px;
  }
  button {
    border: none;
    background: none;
    border-radius: 3px;
    font-size: 12px;
  }
  button:hover {
    background: var(--bg-hover);
  }
  .dim {
    color: var(--fg-dim);
  }
  .warn {
    color: var(--dirty);
  }
  .spacer {
    flex: 1;
  }
</style>
